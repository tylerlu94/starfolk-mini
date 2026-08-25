#!/bin/sh
set -eu

script_directory=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd)
launcher_path=$script_directory/bin/sfkm
install_directory=${SFKM_INSTALL_DIR:-$HOME/.local/bin}
installed_command=$install_directory/sfkm
config_file=${SFKM_CONFIG_FILE:-$HOME/.config/sfkm/config.json}

usage() {
  printf '%s\n' \
    "Usage: ./apps/cli/install.sh [--uninstall]" \
    "" \
    "Installs a local sfkm command linked to this repository checkout." \
    "Set SFKM_INSTALL_DIR to override the default ~/.local/bin location."
}

uninstall() {
  if [ ! -L "$installed_command" ]; then
    if [ -e "$installed_command" ]; then
      printf '%s\n' "Refusing to remove $installed_command because it is not an SFKM symlink." >&2
      exit 1
    fi
    printf '%s\n' "SFKM is not installed at $installed_command."
    return
  fi

  installed_target=$(readlink "$installed_command")
  case "$installed_target" in
    */apps/cli/bin/sfkm)
      rm "$installed_command"
      printf '%s\n' "Removed $installed_command. The configuration file was left in place."
      ;;
    *)
      printf '%s\n' "Refusing to remove $installed_command because it points somewhere unexpected." >&2
      exit 1
      ;;
  esac
}

case ${1:-} in
  "") ;;
  --help|-h)
    usage
    exit 0
    ;;
  --uninstall)
    uninstall
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "Node.js 24 is required." >&2
  exit 1
fi
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" != "24" ]; then
  printf '%s\n' "Node.js 24 is required; found $(node --version)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' "npm 11 is required." >&2
  exit 1
fi
npm_major=$(npm --version | cut -d. -f1)
if [ "$npm_major" != "11" ]; then
  printf '%s\n' "npm 11 is required; found $(npm --version)." >&2
  exit 1
fi

if [ ! -f "$repository_root/node_modules/tsx/dist/loader.mjs" ] || \
   [ ! -e "$repository_root/node_modules/@sfkm/contracts" ]; then
  printf '%s\n' "Installing repository dependencies with npm ci..."
  (cd "$repository_root" && npm ci)
fi

mkdir -p "$install_directory"
if [ -e "$installed_command" ] || [ -L "$installed_command" ]; then
  if [ ! -L "$installed_command" ] || [ "$(readlink "$installed_command")" != "$launcher_path" ]; then
    printf '%s\n' "Refusing to replace existing command: $installed_command" >&2
    exit 1
  fi
else
  ln -s "$launcher_path" "$installed_command"
fi

printf '%s\n' "Installed sfkm at $installed_command."

case :${PATH:-}: in
  *:"$install_directory":*) ;;
  *)
    printf '%s\n' \
      "$install_directory is not currently on PATH." \
      "Add this line to your shell profile, then open a new terminal:" \
      "  export PATH=\"$install_directory:\$PATH\""
    ;;
esac

if [ -f "$config_file" ]; then
  printf '%s\n' "Using existing configuration at $config_file."
elif [ -t 0 ] && [ -t 1 ]; then
  printf '%s' "Demo API token (leave blank to configure later): "
  stty -echo
  restore_terminal=true
  trap 'if [ "${restore_terminal:-false}" = true ]; then stty echo; printf "\n"; fi' EXIT HUP INT TERM
  IFS= read -r api_token || api_token=
  stty echo
  restore_terminal=false
  trap - EXIT HUP INT TERM
  printf '\n'

  if [ -n "$api_token" ]; then
    config_directory=$(dirname -- "$config_file")
    config_temporary=$config_file.tmp.$$
    umask 077
    mkdir -p "$config_directory"
    trap 'rm -f "$config_temporary"' EXIT HUP INT TERM
    printf '%s' "$api_token" | node -e '
      let token = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { token += chunk; });
      process.stdin.on("end", () => process.stdout.write(`${JSON.stringify({ apiToken: token })}\n`));
    ' > "$config_temporary"
    chmod 600 "$config_temporary"
    mv "$config_temporary" "$config_file"
    trap - EXIT HUP INT TERM
    unset api_token
    printf '%s\n' "Saved the API token to $config_file with mode 0600."
  fi
fi

printf '%s\n' \
  "The CLI targets https://sfkm-backend-production.up.railway.app by default." \
  "Run: sfkm --help"
