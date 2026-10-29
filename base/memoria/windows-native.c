/* Win64 N-API bootstrap for Node >=18. Build with windows-native-build.sh.
 * No runtime SDK, daemon, environment path, or repository command is required.
 */
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shlobj.h>
#include <aclapi.h>
#include <sddl.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <wincrypt.h>

typedef struct { HANDLE handle; DWORD thread; int held; } Lease;
typedef struct { HANDLE handle; OVERLAPPED overlap; int held; } FileLease;
typedef struct { HANDLE handle; int held; } ReadLease;
typedef struct { int publishing_callback; } PublishState;

static napi_value fail(napi_env env, const char *code) {
  napi_throw_error(env, code, code);
  return NULL;
}
static int property(napi_env env, napi_value object, const char *name, const wchar_t *value) {
  napi_value string;
  return napi_create_string_utf16(env, (const char16_t *)value, NAPI_AUTO_LENGTH, &string) == napi_ok &&
    napi_set_named_property(env, object, name, string) == napi_ok;
}
static napi_value locations(napi_env env, napi_callback_info info) {
  (void)info;
  wchar_t windows[MAX_PATH], program[MAX_PATH], programX86[MAX_PATH];
  UINT size = GetSystemWindowsDirectoryW(windows, MAX_PATH);
  if (!size || size >= MAX_PATH ||
      FAILED(SHGetFolderPathW(NULL, CSIDL_PROGRAM_FILES, NULL, SHGFP_TYPE_CURRENT, program)) ||
      FAILED(SHGetFolderPathW(NULL, CSIDL_PROGRAM_FILESX86, NULL, SHGFP_TYPE_CURRENT, programX86))) {
    return fail(env, "windows_locations_failed");
  }
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !property(env, result, "windows", windows) ||
      !property(env, result, "programFiles", program) ||
      !property(env, result, "programFilesX86", programX86)) return fail(env, "windows_locations_failed");
  return result;
}
static void lease_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  Lease *lease = (Lease *)data;
  if (lease->held && lease->thread == GetCurrentThreadId()) ReleaseMutex(lease->handle);
  if (lease->handle) CloseHandle(lease->handle);
  free(lease);
}
static napi_value acquire(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1, length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_string_utf8(env, argv[0], NULL, 0, &length) != napi_ok ||
      length != 64) return fail(env, "windows_lock_key");
  char key[65];
  if (napi_get_value_string_utf8(env, argv[0], key, sizeof(key), &length) != napi_ok) {
    return fail(env, "windows_lock_key");
  }
  for (size_t i = 0; i < 64; i++) if (!((key[i] >= '0' && key[i] <= '9') ||
      (key[i] >= 'a' && key[i] <= 'f'))) return fail(env, "windows_lock_key");
  HANDLE token = NULL;
  DWORD bytes = 0;
  PTOKEN_USER user = NULL;
  LPWSTR sid = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  HANDLE mutex = NULL;
  int ok = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
  GetTokenInformation(token, TokenUser, NULL, 0, &bytes);
  if (!bytes || bytes > 65536) goto cleanup;
  user = (PTOKEN_USER)malloc(bytes);
  if (!user || !GetTokenInformation(token, TokenUser, user, bytes, &bytes) ||
      !ConvertSidToStringSidW(user->User.Sid, &sid)) goto cleanup;
  wchar_t name[512], sddl[512];
  if (swprintf(name, 512, L"Global\\CBS-Mem0-%ls-%hs", sid, key) < 0 ||
      swprintf(sddl, 512, L"O:%lsD:P(A;;GA;;;%ls)(A;;GA;;;SY)(A;;GA;;;BA)", sid, sid) < 0 ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1,
        &descriptor, NULL)) goto cleanup;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), descriptor, FALSE };
  mutex = CreateMutexW(&attributes, FALSE, name);
  if (!mutex) goto cleanup;
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR current = NULL;
  DWORD securityStatus = GetSecurityInfo(mutex, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
    &owner, NULL, NULL, NULL, &current);
  if (securityStatus != ERROR_SUCCESS || !owner || !EqualSid(owner, user->User.Sid)) {
    if (current) LocalFree(current);
    goto cleanup;
  }
  LocalFree(current);
  DWORD wait = WaitForSingleObject(mutex, 5000);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) goto cleanup;
  ok = 1;
cleanup:
  if (token) CloseHandle(token);
  if (user) free(user);
  if (sid) LocalFree(sid);
  if (descriptor) LocalFree(descriptor);
  if (!ok) {
    if (mutex) CloseHandle(mutex);
    return fail(env, "windows_lock_failed");
  }
  Lease *lease = (Lease *)calloc(1, sizeof(Lease));
  if (!lease) { ReleaseMutex(mutex); CloseHandle(mutex); return fail(env, "windows_lock_failed"); }
  lease->handle = mutex;
  lease->thread = GetCurrentThreadId();
  lease->held = 1;
  napi_value external;
  if (napi_create_external(env, lease, lease_finalizer, NULL, &external) != napi_ok) {
    lease_finalizer(env, lease, NULL);
    return fail(env, "windows_lock_failed");
  }
  return external;
}
static napi_value release(napi_env env, napi_callback_info info) {
  napi_value argv[1], result;
  size_t argc = 1;
  Lease *lease = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], (void **)&lease) != napi_ok || !lease ||
      !lease->held || lease->thread != GetCurrentThreadId() ||
      !ReleaseMutex(lease->handle)) return fail(env, "windows_lock_release_failed");
  lease->held = 0;
  CloseHandle(lease->handle);
  lease->handle = NULL;
  if (napi_get_boolean(env, true, &result) != napi_ok) return fail(env, "windows_lock_release_failed");
  return result;
}

#define EXTENDED_PREFIX_CHARS 4

static int path_arg(napi_env env, napi_value value, wchar_t **out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
      length < 3 || length > 32700) return 0;
  wchar_t *path = (wchar_t *)calloc(length + 1, sizeof(wchar_t));
  if (!path) return 0;
  size_t actual = 0;
  if (napi_get_value_string_utf16(env, value, (char16_t *)path, length + 1, &actual) != napi_ok ||
      actual != length || !((path[0] >= L'A' && path[0] <= L'Z') ||
        (path[0] >= L'a' && path[0] <= L'z')) || path[1] != L':' || path[2] != L'\\') {
    free(path);
    return 0;
  }
  for (size_t i = 0; i < length; i++) if (path[i] < 32 || wcschr(L"<>|\"?*", path[i])) {
    free(path);
    return 0;
  }
  /* The addon does not inherit the long-path opt-in: CreateFileW and FileRenameInfo failed
     at MAX_PATH (journal receipts reach ~277 chars). Win32 calls get the \\?\ form of the
     validated drive-absolute path; it disables normalization, so separators are fixed here. */
  wchar_t *extended = (wchar_t *)calloc(EXTENDED_PREFIX_CHARS + length + 1, sizeof(wchar_t));
  if (!extended) { free(path); return 0; }
  wcscpy(extended, L"\\\\?\\");
  for (size_t i = 0; i < length; i++) {
    extended[EXTENDED_PREFIX_CHARS + i] = path[i] == L'/' ? L'\\' : path[i];
  }
  free(path);
  *out = extended;
  return 1;
}

static int owner_sid(PSID *sid, HANDLE *token, PTOKEN_USER *user) {
  DWORD bytes = 0;
  *sid = NULL; *token = NULL; *user = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token)) return 0;
  GetTokenInformation(*token, TokenUser, NULL, 0, &bytes);
  if (!bytes || bytes > 65536) return 0;
  *user = (PTOKEN_USER)malloc(bytes);
  if (!*user || !GetTokenInformation(*token, TokenUser, *user, bytes, &bytes)) return 0;
  *sid = (*user)->User.Sid;
  return 1;
}

static int audit_file(HANDLE handle, int private_state, BY_HANDLE_FILE_INFORMATION *info,
    FILE_STANDARD_INFO *standard) {
  if (!GetFileInformationByHandle(handle, info) ||
      (info->dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, standard, sizeof(*standard)) ||
      standard->NumberOfLinks != 1) return 0;
  wchar_t fs_name[32];
  if (!GetVolumeInformationByHandleW(handle, NULL, 0, NULL, NULL, NULL,
      fs_name, sizeof(fs_name) / sizeof(fs_name[0])) || _wcsicmp(fs_name, L"NTFS") != 0) return 0;
  PSID current = NULL, owner = NULL;
  HANDLE token = NULL;
  PTOKEN_USER user = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  int good = 0;
  if (!owner_sid(&current, &token, &user)) goto cleanup;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &dacl, NULL, &descriptor) != ERROR_SUCCESS || !owner || !dacl ||
      !EqualSid(owner, current)) goto cleanup;
  SECURITY_DESCRIPTOR_CONTROL control;
  DWORD revision;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      (private_state && !(control & SE_DACL_PROTECTED))) goto cleanup;
  ACL_SIZE_INFORMATION acl_info;
  if (!GetAclInformation(dacl, &acl_info, sizeof(acl_info), AclSizeInformation)) goto cleanup;
  DWORD owner_rights = 0;
  for (DWORD i = 0; i < acl_info.AceCount; i++) {
    void *entry = NULL;
    if (!GetAce(dacl, i, &entry)) goto cleanup;
    ACE_HEADER *header = (ACE_HEADER *)entry;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) goto cleanup;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)entry;
    PSID principal = &ace->SidStart;
    if (EqualSid(principal, current)) {
      DWORD rights = ace->Mask;
      GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
      MapGenericMask(&rights, &mapping);
      owner_rights |= rights;
    }
    else if (!IsWellKnownSid(principal, WinLocalSystemSid) &&
        !IsWellKnownSid(principal, WinBuiltinAdministratorsSid)) {
      /* Outside private state only integrity matters: a read/execute-only grant to another
         principal (e.g. CodexSandboxUsers inherited under the profile) cannot alter the file. */
      DWORD rights = ace->Mask;
      GENERIC_MAPPING mapping = { FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_GENERIC_EXECUTE, FILE_ALL_ACCESS };
      MapGenericMask(&rights, &mapping);
      const DWORD mutating = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
        FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER;
      if (private_state || (rights & mutating)) goto cleanup;
    }
  }
  if ((owner_rights & FILE_READ_DATA) && (owner_rights & FILE_WRITE_DATA)) good = 1;
cleanup:
  if (descriptor) LocalFree(descriptor);
  if (user) free(user);
  if (token) CloseHandle(token);
  return good;
}

static int result_identity(napi_env env, napi_value object, BY_HANDLE_FILE_INFORMATION *info,
    FILE_STANDARD_INFO *standard) {
  char id[27];
  snprintf(id, sizeof(id), "%08lx:%08lx%08lx", (unsigned long)info->dwVolumeSerialNumber,
    (unsigned long)info->nFileIndexHigh, (unsigned long)info->nFileIndexLow);
  napi_value value;
  if (napi_create_string_utf8(env, id, NAPI_AUTO_LENGTH, &value) != napi_ok ||
      napi_set_named_property(env, object, "fileId", value) != napi_ok ||
      napi_create_double(env, (double)standard->AllocationSize.QuadPart, &value) != napi_ok ||
      napi_set_named_property(env, object, "allocatedBytes", value) != napi_ok ||
      napi_create_double(env, (double)standard->EndOfFile.QuadPart, &value) != napi_ok ||
      napi_set_named_property(env, object, "size", value) != napi_ok) return 0;
  return 1;
}

static napi_value read_private(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4;
  wchar_t *path = NULL;
  int64_t offset = 0;
  uint32_t length = 0;
  bool private_state = true;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_value_int64(env, argv[1], &offset) != napi_ok || offset < 0 ||
      napi_get_value_uint32(env, argv[2], &length) != napi_ok || length > 16 * 1024 * 1024 ||
      napi_get_value_bool(env, argv[3], &private_state) != napi_ok) {
    free(path);
    return fail(env, "windows_read_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_read_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  if (!audit_file(handle, private_state, &file_info, &standard)) {
    CloseHandle(handle);
    return fail(env, "windows_read_unsafe");
  }
  LARGE_INTEGER location;
  location.QuadPart = offset;
  if (!SetFilePointerEx(handle, location, NULL, FILE_BEGIN)) {
    CloseHandle(handle);
    return fail(env, "windows_read_seek");
  }
  unsigned char *buffer = (unsigned char *)malloc(length ? length : 1);
  if (!buffer) { CloseHandle(handle); return fail(env, "windows_read_memory"); }
  DWORD count = 0;
  int okay = 1;
  while (count < length) {
    DWORD part = 0;
    DWORD amount = length - count;
    if (!ReadFile(handle, buffer + count, amount, &part, NULL)) { okay = 0; break; }
    if (!part) break;
    count += part;
  }
  CloseHandle(handle);
  if (!okay) { free(buffer); return fail(env, "windows_read_failed"); }
  napi_value result, bytes;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_buffer_copy(env, count, buffer, NULL, &bytes) != napi_ok ||
      napi_set_named_property(env, result, "bytes", bytes) != napi_ok ||
      !result_identity(env, result, &file_info, &standard)) {
    free(buffer);
    return fail(env, "windows_read_result");
  }
  free(buffer);
  return result;
}

static int private_attributes(SECURITY_ATTRIBUTES *attributes, PSECURITY_DESCRIPTOR *descriptor) {
  PSID sid = NULL;
  HANDLE token = NULL;
  PTOKEN_USER user = NULL;
  LPWSTR text = NULL;
  int okay = 0;
  *descriptor = NULL;
  if (!owner_sid(&sid, &token, &user) || !ConvertSidToStringSidW(sid, &text)) goto cleanup;
  wchar_t sddl[512];
  if (swprintf(sddl, 512, L"O:%lsD:P(A;;GA;;;%ls)(A;;GA;;;SY)(A;;GA;;;BA)",
      text, text) < 0 ||
      !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1,
        descriptor, NULL)) goto cleanup;
  attributes->nLength = sizeof(*attributes);
  attributes->lpSecurityDescriptor = *descriptor;
  attributes->bInheritHandle = FALSE;
  okay = 1;
cleanup:
  if (text) LocalFree(text);
  if (user) free(user);
  if (token) CloseHandle(token);
  return okay;
}

static void file_lease_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  FileLease *lease = (FileLease *)data;
  if (lease->held) UnlockFileEx(lease->handle, 0, 1, 0, &lease->overlap);
  if (lease->handle != INVALID_HANDLE_VALUE) CloseHandle(lease->handle);
  free(lease);
}

static napi_value lock_file(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  wchar_t *path = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !path_arg(env, argv[0], &path)) return fail(env, "windows_file_lock_args");
  SECURITY_ATTRIBUTES attributes;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!private_attributes(&attributes, &descriptor)) {
    free(path);
    return fail(env, "windows_file_lock_security");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_ALWAYS,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  LocalFree(descriptor);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_file_lock_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  if (!audit_file(handle, 1, &file_info, &standard) || standard.EndOfFile.QuadPart != 0) {
    CloseHandle(handle);
    return fail(env, "windows_file_lock_unsafe");
  }
  FileLease *lease = (FileLease *)calloc(1, sizeof(FileLease));
  if (!lease) { CloseHandle(handle); return fail(env, "windows_file_lock_memory"); }
  lease->handle = handle;
  if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
      0, 1, 0, &lease->overlap)) {
    DWORD error = GetLastError();
    file_lease_finalizer(env, lease, NULL);
    return fail(env, error == ERROR_LOCK_VIOLATION ? "windows_file_lock_busy" :
      "windows_file_lock_failed");
  }
  lease->held = 1;
  napi_value result, external;
  if (napi_create_object(env, &result) != napi_ok ||
      !result_identity(env, result, &file_info, &standard) ||
      napi_create_external(env, lease, file_lease_finalizer, NULL, &external) != napi_ok) {
    file_lease_finalizer(env, lease, NULL);
    return fail(env, "windows_file_lock_result");
  }
  if (napi_set_named_property(env, result, "lease", external) != napi_ok) {
    UnlockFileEx(lease->handle, 0, 1, 0, &lease->overlap);
    lease->held = 0;
    CloseHandle(lease->handle);
    lease->handle = INVALID_HANDLE_VALUE;
    return fail(env, "windows_file_lock_result");
  }
  return result;
}

static napi_value unlock_file(napi_env env, napi_callback_info info) {
  napi_value argv[1], result;
  size_t argc = 1;
  FileLease *lease = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], (void **)&lease) != napi_ok || !lease ||
      !lease->held || !UnlockFileEx(lease->handle, 0, 1, 0, &lease->overlap)) {
    return fail(env, "windows_file_unlock_failed");
  }
  lease->held = 0;
  CloseHandle(lease->handle);
  lease->handle = INVALID_HANDLE_VALUE;
  if (napi_get_boolean(env, true, &result) != napi_ok) return fail(env, "windows_file_unlock_failed");
  return result;
}

static int write_all(HANDLE handle, const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    DWORD written = 0;
    DWORD amount = length - offset > 1024 * 1024 ? 1024 * 1024 : (DWORD)(length - offset);
    if (!WriteFile(handle, bytes + offset, amount, &written, NULL) || written != amount) return 0;
    offset += written;
  }
  return 1;
}

static int read_exact(HANDLE handle, unsigned char *bytes, size_t length) {
  LARGE_INTEGER start;
  start.QuadPart = 0;
  if (!SetFilePointerEx(handle, start, NULL, FILE_BEGIN)) return 0;
  size_t offset = 0;
  while (offset < length) {
    DWORD count = 0;
    DWORD amount = length - offset > 1024 * 1024 ? 1024 * 1024 : (DWORD)(length - offset);
    if (!ReadFile(handle, bytes + offset, amount, &count, NULL) || count != amount) return 0;
    offset += count;
  }
  return 1;
}

static int expected_identity(napi_env env, napi_value value, BY_HANDLE_FILE_INFORMATION *info) {
  char given[27], actual[27];
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, given, sizeof(given), &length) != napi_ok ||
      length != 25) return 0;
  snprintf(actual, sizeof(actual), "%08lx:%08lx%08lx", (unsigned long)info->dwVolumeSerialNumber,
    (unsigned long)info->nFileIndexHigh, (unsigned long)info->nFileIndexLow);
  return strcmp(given, actual) == 0;
}

static int matches_expected(HANDLE handle, const unsigned char *expected, size_t length,
    FILE_STANDARD_INFO *standard) {
  if (standard->EndOfFile.QuadPart != (LONGLONG)length) return 0;
  unsigned char *observed = (unsigned char *)malloc(length ? length : 1);
  if (!observed) return 0;
  int same = read_exact(handle, observed, length) && memcmp(observed, expected, length) == 0;
  free(observed);
  return same;
}

static napi_value rewrite_existing(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4, old_length = 0, new_length = 0;
  wchar_t *path = NULL;
  unsigned char *old_bytes = NULL, *new_bytes = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_buffer_info(env, argv[2], (void **)&old_bytes, &old_length) != napi_ok ||
      napi_get_buffer_info(env, argv[3], (void **)&new_bytes, &new_length) != napi_ok ||
      old_length > 16 * 1024 * 1024 || new_length > 16 * 1024 * 1024) {
    free(path);
    return fail(env, "windows_rewrite_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_rewrite_open");
  BY_HANDLE_FILE_INFORMATION file_info, after;
  FILE_STANDARD_INFO standard, after_standard;
  int okay = audit_file(handle, 1, &file_info, &standard) &&
    expected_identity(env, argv[1], &file_info) &&
    matches_expected(handle, old_bytes, old_length, &standard);
  if (!okay) { CloseHandle(handle); return fail(env, "windows_rewrite_changed"); }
  LARGE_INTEGER start;
  start.QuadPart = 0;
  okay = SetFilePointerEx(handle, start, NULL, FILE_BEGIN) &&
    write_all(handle, new_bytes, new_length) && SetEndOfFile(handle) &&
    FlushFileBuffers(handle) &&
    audit_file(handle, 1, &after, &after_standard) &&
    after.dwVolumeSerialNumber == file_info.dwVolumeSerialNumber &&
    after.nFileIndexHigh == file_info.nFileIndexHigh &&
    after.nFileIndexLow == file_info.nFileIndexLow &&
    matches_expected(handle, new_bytes, new_length, &after_standard);
  CloseHandle(handle);
  if (!okay) return fail(env, "windows_rewrite_failed");
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !result_identity(env, result, &after, &after_standard)) return fail(env, "windows_rewrite_result");
  return result;
}

static napi_value delete_expected(napi_env env, napi_callback_info info) {
  napi_value argv[3], result;
  size_t argc = 3, expected_length = 0;
  wchar_t *path = NULL;
  unsigned char *expected = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_buffer_info(env, argv[2], (void **)&expected, &expected_length) != napi_ok ||
      expected_length > 16 * 1024 * 1024) {
    free(path);
    return fail(env, "windows_delete_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | DELETE | READ_CONTROL, 0,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_delete_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  int okay = audit_file(handle, 1, &file_info, &standard) &&
    expected_identity(env, argv[1], &file_info) &&
    matches_expected(handle, expected, expected_length, &standard);
  if (okay) {
    FILE_DISPOSITION_INFO disposition = { TRUE };
    okay = SetFileInformationByHandle(handle, FileDispositionInfo, &disposition,
      sizeof(disposition));
  }
  CloseHandle(handle);
  if (!okay) return fail(env, "windows_delete_changed");
  if (napi_get_boolean(env, true, &result) != napi_ok) return fail(env, "windows_delete_result");
  return result;
}

static void read_lease_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  ReadLease *lease = (ReadLease *)data;
  if (lease->held) CloseHandle(lease->handle);
  free(lease);
}

static napi_value hold_private(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3, length = 0;
  wchar_t *path = NULL;
  unsigned char *expected = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_buffer_info(env, argv[2], (void **)&expected, &length) != napi_ok ||
      length > 16 * 1024 * 1024) {
    free(path);
    return fail(env, "windows_hold_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_hold_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  if (!audit_file(handle, 1, &file_info, &standard) ||
      !expected_identity(env, argv[1], &file_info) ||
      !matches_expected(handle, expected, length, &standard)) {
    CloseHandle(handle);
    return fail(env, "windows_hold_changed");
  }
  ReadLease *lease = (ReadLease *)calloc(1, sizeof(ReadLease));
  if (!lease) { CloseHandle(handle); return fail(env, "windows_hold_memory"); }
  lease->handle = handle;
  lease->held = 1;
  napi_value external;
  if (napi_create_external(env, lease, read_lease_finalizer, NULL, &external) != napi_ok) {
    read_lease_finalizer(env, lease, NULL);
    return fail(env, "windows_hold_result");
  }
  return external;
}

static napi_value release_private(napi_env env, napi_callback_info info) {
  napi_value argv[1], result;
  size_t argc = 1;
  ReadLease *lease = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], (void **)&lease) != napi_ok ||
      !lease || !lease->held) return fail(env, "windows_hold_release");
  CloseHandle(lease->handle);
  lease->held = 0;
  lease->handle = INVALID_HANDLE_VALUE;
  if (napi_get_boolean(env, true, &result) != napi_ok) return fail(env, "windows_hold_release");
  return result;
}

static int hash_handle(HANDLE handle, char digest[65]) {
  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  LARGE_INTEGER start;
  start.QuadPart = 0;
  if (!SetFilePointerEx(handle, start, NULL, FILE_BEGIN) ||
      !CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
      !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash)) goto fail_hash;
  unsigned char bytes[65536], result[32];
  DWORD count = 0, result_size = sizeof(result);
  do {
    if (!ReadFile(handle, bytes, sizeof(bytes), &count, NULL) ||
        (count && !CryptHashData(hash, bytes, count, 0))) goto fail_hash;
  } while (count);
  if (!CryptGetHashParam(hash, HP_HASHVAL, result, &result_size, 0) || result_size != 32) goto fail_hash;
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < 32; i++) {
    digest[2 * i] = hex[result[i] >> 4];
    digest[2 * i + 1] = hex[result[i] & 15];
  }
  digest[64] = 0;
  CryptDestroyHash(hash);
  CryptReleaseContext(provider, 0);
  return 1;
fail_hash:
  if (hash) CryptDestroyHash(hash);
  if (provider) CryptReleaseContext(provider, 0);
  return 0;
}

static napi_value hash_private(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  wchar_t *path = NULL;
  bool private_state = true;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_value_bool(env, argv[1], &private_state) != napi_ok) {
    free(path);
    return fail(env, "windows_hash_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_hash_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  char digest[65];
  int okay = audit_file(handle, private_state, &file_info, &standard) &&
    standard.EndOfFile.QuadPart >= 0 && standard.EndOfFile.QuadPart <= 512LL * 1024 * 1024 &&
    hash_handle(handle, digest);
  CloseHandle(handle);
  if (!okay) return fail(env, "windows_hash_unsafe");
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok ||
      !result_identity(env, result, &file_info, &standard) ||
      napi_create_string_utf8(env, digest, 64, &value) != napi_ok ||
      napi_set_named_property(env, result, "sha256", value) != napi_ok) {
    return fail(env, "windows_hash_result");
  }
  return result;
}

static napi_value hold_hash(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4;
  wchar_t *path = NULL;
  bool private_state = true;
  char expected[65], actual[65];
  size_t length = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
      !path_arg(env, argv[0], &path) ||
      napi_get_value_string_utf8(env, argv[2], expected, sizeof(expected), &length) != napi_ok ||
      length != 64 || napi_get_value_bool(env, argv[3], &private_state) != napi_ok) {
    free(path);
    return fail(env, "windows_hold_hash_args");
  }
  HANDLE handle = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (handle == INVALID_HANDLE_VALUE) return fail(env, "windows_hold_hash_open");
  BY_HANDLE_FILE_INFORMATION file_info;
  FILE_STANDARD_INFO standard;
  if (!audit_file(handle, private_state, &file_info, &standard) ||
      !expected_identity(env, argv[1], &file_info) ||
      !hash_handle(handle, actual) || strcmp(expected, actual) != 0) {
    CloseHandle(handle);
    return fail(env, "windows_hold_hash_changed");
  }
  ReadLease *lease = (ReadLease *)calloc(1, sizeof(ReadLease));
  if (!lease) { CloseHandle(handle); return fail(env, "windows_hold_hash_memory"); }
  lease->handle = handle;
  lease->held = 1;
  napi_value external;
  if (napi_create_external(env, lease, read_lease_finalizer, NULL, &external) != napi_ok) {
    read_lease_finalizer(env, lease, NULL);
    return fail(env, "windows_hold_hash_result");
  }
  return external;
}

static napi_value publish_new(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc = 4, byte_length = 0;
  wchar_t *temporary = NULL, *target = NULL;
  unsigned char *bytes = NULL;
  napi_valuetype callback_type = napi_undefined;
  PublishState *state = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      (argc != 3 && argc != 4) ||
      !path_arg(env, argv[0], &temporary) || !path_arg(env, argv[1], &target) ||
      napi_get_buffer_info(env, argv[2], (void **)&bytes, &byte_length) != napi_ok ||
      byte_length > 16 * 1024 * 1024 ||
      (argc == 4 && napi_typeof(env, argv[3], &callback_type) != napi_ok) ||
      (argc == 4 && callback_type != napi_undefined && callback_type != napi_function) ||
      napi_get_instance_data(env, (void **)&state) != napi_ok || !state ||
      state->publishing_callback) {
    free(temporary); free(target);
    return fail(env, "windows_publish_args");
  }
  wchar_t *temp_name = wcsrchr(temporary, L'\\');
  wchar_t *target_name = wcsrchr(target, L'\\');
  if (!temp_name || !target_name || temp_name - temporary != target_name - target ||
      _wcsnicmp(temporary, target, temp_name - temporary) != 0 ||
      wcscmp(temp_name, target_name) == 0) {
    free(temporary); free(target);
    return fail(env, "windows_publish_parent");
  }
  SECURITY_ATTRIBUTES attributes;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (!private_attributes(&attributes, &descriptor)) {
    free(temporary); free(target);
    return fail(env, "windows_publish_security");
  }
  HANDLE handle = CreateFileW(temporary, GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL,
    0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH |
      FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  LocalFree(descriptor);
  if (handle == INVALID_HANDLE_VALUE) {
    free(temporary); free(target); return fail(env, "windows_publish_temp");
  }
  BY_HANDLE_FILE_INFORMATION first, after;
  FILE_STANDARD_INFO standard, after_standard;
  int published = 0;
  int callback_failed = 0;
  int okay = audit_file(handle, 1, &first, &standard) &&
    write_all(handle, bytes, byte_length) && FlushFileBuffers(handle);
  if (okay && argc == 4 && callback_type == napi_function) {
    BY_HANDLE_FILE_INFORMATION flushed;
    FILE_STANDARD_INFO flushed_standard;
    okay = audit_file(handle, 1, &flushed, &flushed_standard) &&
      flushed.dwVolumeSerialNumber == first.dwVolumeSerialNumber &&
      flushed.nFileIndexHigh == first.nFileIndexHigh &&
      flushed.nFileIndexLow == first.nFileIndexLow &&
      flushed_standard.EndOfFile.QuadPart == (LONGLONG)byte_length;
    if (okay) {
      napi_value observation, receiver, result, undefined;
      state->publishing_callback = 1;
      napi_status status = napi_create_object(env, &observation);
      if (status == napi_ok) status = property(env, observation, "boundary",
        L"temp_flushed_before_publish") ? napi_ok : napi_generic_failure;
      if (status == napi_ok) status = property(env, observation, "temporary",
        temporary + EXTENDED_PREFIX_CHARS) ? napi_ok : napi_generic_failure;
      if (status == napi_ok) status = property(env, observation, "target", target + EXTENDED_PREFIX_CHARS)
        ? napi_ok : napi_generic_failure;
      if (status == napi_ok) status = result_identity(env, observation,
        &flushed, &flushed_standard) ? napi_ok : napi_generic_failure;
      if (status == napi_ok) status = napi_get_global(env, &receiver);
      if (status == napi_ok) status = napi_get_undefined(env, &undefined);
      if (status == napi_ok) status = napi_call_function(env, receiver, argv[3],
        1, &observation, &result);
      if (status == napi_ok) {
        bool same = false;
        status = napi_strict_equals(env, result, undefined, &same);
        if (status == napi_ok && !same) status = napi_generic_failure;
      }
      state->publishing_callback = 0;
      if (status != napi_ok) { okay = 0; callback_failed = 1; }
      if (okay) {
        BY_HANDLE_FILE_INFORMATION checked;
        FILE_STANDARD_INFO checked_standard;
        okay = audit_file(handle, 1, &checked, &checked_standard) &&
          checked.dwVolumeSerialNumber == flushed.dwVolumeSerialNumber &&
          checked.nFileIndexHigh == flushed.nFileIndexHigh &&
          checked.nFileIndexLow == flushed.nFileIndexLow &&
          checked_standard.EndOfFile.QuadPart == flushed_standard.EndOfFile.QuadPart;
      }
    }
  }
  if (okay) {
    size_t name_bytes = wcslen(target) * sizeof(wchar_t);
    /* kernel32 converts the path in FileName as a NUL-terminated string, so the
       buffer must keep the terminator: sizeof includes FileName[1] and calloc zeroes it.
       Without it, heap bytes past the name were appended to the published file name. */
    size_t struct_bytes = sizeof(FILE_RENAME_INFO) + name_bytes;
    FILE_RENAME_INFO *rename = (FILE_RENAME_INFO *)calloc(1, struct_bytes);
    if (rename) {
      rename->ReplaceIfExists = FALSE;
      rename->RootDirectory = NULL;
      rename->FileNameLength = (DWORD)name_bytes;
      memcpy(rename->FileName, target, name_bytes);
      if (SetFileInformationByHandle(handle, FileRenameInfo, rename, (DWORD)struct_bytes)) published = 1;
      free(rename);
    }
  }
  free(temporary);
  free(target);
  if (published) okay = audit_file(handle, 1, &after, &after_standard) &&
    after.dwVolumeSerialNumber == first.dwVolumeSerialNumber &&
    after.nFileIndexHigh == first.nFileIndexHigh && after.nFileIndexLow == first.nFileIndexLow &&
    after_standard.EndOfFile.QuadPart == (LONGLONG)byte_length;
  else {
    FILE_DISPOSITION_INFO disposition = { TRUE };
    SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition));
  }
  CloseHandle(handle);
  if (callback_failed) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return NULL;
    return fail(env, "windows_publish_callback");
  }
  if (!published || !okay) return fail(env, "windows_publish_failed");
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok ||
      !result_identity(env, result, &after, &after_standard)) return fail(env, "windows_publish_result");
  return result;
}
static void publish_state_finalizer(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  free(data);
}
static napi_value init(napi_env env, napi_value exports) {
  PublishState *state = (PublishState *)calloc(1, sizeof(PublishState));
  if (!state) return fail(env, "windows_publish_state");
  if (napi_set_instance_data(env, state, publish_state_finalizer, NULL) != napi_ok) {
    free(state);
    return fail(env, "windows_publish_state");
  }
  napi_property_descriptor descriptors[] = {
    { "locations", NULL, locations, NULL, NULL, NULL, napi_default, NULL },
    { "acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL },
    { "readPrivate", NULL, read_private, NULL, NULL, NULL, napi_default, NULL },
    { "fileLock", NULL, lock_file, NULL, NULL, NULL, napi_default, NULL },
    { "fileUnlock", NULL, unlock_file, NULL, NULL, NULL, napi_default, NULL },
    { "publishNew", NULL, publish_new, NULL, NULL, NULL, napi_default, NULL },
    { "rewriteExisting", NULL, rewrite_existing, NULL, NULL, NULL, napi_default, NULL },
    { "deleteExpected", NULL, delete_expected, NULL, NULL, NULL, napi_default, NULL },
    { "holdPrivate", NULL, hold_private, NULL, NULL, NULL, napi_default, NULL },
    { "releasePrivate", NULL, release_private, NULL, NULL, NULL, napi_default, NULL },
    { "hashPrivate", NULL, hash_private, NULL, NULL, NULL, napi_default, NULL },
    { "holdHash", NULL, hold_hash, NULL, NULL, NULL, napi_default, NULL }
  };
  if (napi_define_properties(env, exports, 13, descriptors) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(windows_native, init)
