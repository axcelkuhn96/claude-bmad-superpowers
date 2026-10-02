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

typedef struct { HANDLE handle; DWORD thread; int held; } Lease;

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
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    { "locations", NULL, locations, NULL, NULL, NULL, napi_default, NULL },
    { "acquire", NULL, acquire, NULL, NULL, NULL, napi_default, NULL },
    { "release", NULL, release, NULL, NULL, NULL, napi_default, NULL }
  };
  if (napi_define_properties(env, exports, 3, descriptors) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(windows_native, init)
