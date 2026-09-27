#!/bin/sh
# Launcher POSIX dos hooks CBS: acha um node e executa "$@" com ele (stdin/stdout/stderr e exit code repassados).
# Ordem: node gravado na instalação (.cbs-node-path ao lado) → PATH → nvm mais novo → fnm mais novo → volta.
# Nenhum node → exit 0 silencioso: hook nunca quebra a sessão.

ok() { [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ]; }

# Lê caminhos (um por linha) com um diretório vX.Y.Z e devolve o de versão maior (ordem numérica).
mais_novo() {
  sed -n 's|^\(.*/v\([0-9]*\)\.\([0-9]*\)\.\([0-9]*\)/.*\)$|\2 \3 \4 \1|p' \
    | sort -n -k1,1 -k2,2 -k3,3 | tail -n 1 | cut -d ' ' -f 4-
}

listar() { for c in "$@"; do ok "$c" && printf '%s\n' "$c"; done; }

gravado=
arq_path="$(dirname "$0")/.cbs-node-path"
if [ -r "$arq_path" ]; then IFS= read -r gravado < "$arq_path" || :; fi
if ok "$gravado"; then exec "$gravado" "$@"; fi

n=$(command -v node 2>/dev/null)
if ok "$n"; then exec "$n" "$@"; fi

n=$(listar "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node | mais_novo)
if ok "$n"; then exec "$n" "$@"; fi

n=$(listar "${FNM_DIR:-$HOME/.local/share/fnm}"/node-versions/*/installation/bin/node \
  "$HOME"/.fnm/node-versions/*/installation/bin/node \
  "$HOME/Library/Application Support/fnm"/node-versions/*/installation/bin/node | mais_novo)
if ok "$n"; then exec "$n" "$@"; fi

n="${VOLTA_HOME:-$HOME/.volta}/bin/node"
if ok "$n"; then exec "$n" "$@"; fi

exit 0
