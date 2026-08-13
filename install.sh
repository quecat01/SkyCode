#!/usr/bin/env bash
#
# install-skycode.sh
#
# Purpose: Automated installer for SkyCode on Linux.
# Mirrors the manual steps documented in README.md:
#   1. Install system prerequisites (apt-based distros only)
#   2. Install/verify Node.js 20+ via NVM (NodeSource is never used)
#   3. Clone or update the SkyCode repository
#   4. npm install + npm run build
#   5. npm link to expose the global `sky` command
#   6. Hand off to `sky setup` (interactive wizard)
#
# Usage:
#   ./install-skycode.sh [--dir <path>] [--no-link] [--node-version <ver>] [-y|--yes]
#
# Options:
#   --dir <path>        Install location (default: $HOME/sky-code)
#   --no-link           Build only, skip `npm link` (no global `sky` command)
#   --node-version <v>  Node version to install via nvm (default: --lts)
#   -y, --yes           Don't prompt before apt-installing system packages
#   -h, --help          Show this help text
#
# Safe to re-run: skips steps that are already satisfied, and refuses to
# overwrite an existing install directory that has uncommitted git changes.

set -euo pipefail

# ---------- defaults ----------
REPO_URL="https://github.com/quecat01/SkyCode"
INSTALL_DIR="${SKYCODE_INSTALL_DIR:-$HOME/sky-code}"
NODE_VERSION="--lts"
NVM_VERSION="v0.40.5"
DO_LINK=1
ASSUME_YES=0

# ---------- output helpers ----------
if [ -t 1 ]; then
  C_INFO='\033[96m'; C_OK='\033[92m'; C_WARN='\033[93m'; C_ERR='\033[91m'; C_RESET='\033[0m'
else
  C_INFO=''; C_OK=''; C_WARN=''; C_ERR=''; C_RESET=''
fi
info()  { printf "%b[*]%b %s\n" "$C_INFO" "$C_RESET" "$1"; }
ok()    { printf "%b[OK]%b %s\n" "$C_OK" "$C_RESET" "$1"; }
warn()  { printf "%b[!]%b %s\n" "$C_WARN" "$C_RESET" "$1"; }
err()   { printf "%b[ERROR]%b %s\n" "$C_ERR" "$C_RESET" "$1" >&2; }
step()  { printf "\n%b==> %s%b\n" "$C_INFO" "$1" "$C_RESET"; }

# ---------- arg parsing ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-link) DO_LINK=0; shift ;;
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "Unknown argument: $1"; exit 1 ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local prompt="$1"
  read -r -p "$prompt [Y/n] " reply
  [ -z "$reply" ] || [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------- 0. platform sanity check ----------
step "Checking platform"
if [ "$(uname -s)" != "Linux" ]; then
  err "This script targets Linux. Detected: $(uname -s)."
  exit 1
fi
ok "Running on Linux ($(uname -r))"

# ---------- 1. system prerequisites ----------
step "Checking system prerequisites"
if command -v apt-get >/dev/null 2>&1; then
  MISSING_PKGS=()
  for pkg_bin in gcc git curl; do
    command -v "$pkg_bin" >/dev/null 2>&1 || MISSING_PKGS+=("$pkg_bin")
  done
  if [ "${#MISSING_PKGS[@]}" -gt 0 ]; then
    info "Missing: ${MISSING_PKGS[*]} (installing build-essential git curl via apt)"
    if confirm "Run 'sudo apt update && sudo apt install -y build-essential git curl'?"; then
      sudo apt update
      sudo apt install -y build-essential git curl
      ok "System packages installed"
    else
      err "Prerequisites declined. Cannot continue."
      exit 1
    fi
  else
    ok "build-essential, git, and curl already present"
  fi
else
  warn "No apt-get detected (non-Debian distro)."
  warn "Ensure a C build toolchain, git, and curl are installed manually, then re-run this script."
  for pkg_bin in git curl; do
    command -v "$pkg_bin" >/dev/null 2>&1 || { err "$pkg_bin not found on PATH. Install it and re-run."; exit 1; }
  done
fi

# ---------- 2. Node.js via NVM only ----------
step "Checking Node.js (>=20 required)"

node_ok=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "Node.js $(node -v) already satisfies requirement"
    node_ok=1
  else
    warn "Node.js $(node -v) found but SkyCode requires 20+"
  fi
fi

if [ "$node_ok" -eq 0 ]; then
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing NVM $NVM_VERSION (NodeSource is never used per project policy)"
    curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash
  else
    ok "NVM already installed"
  fi
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  info "Installing Node.js ($NODE_VERSION) via nvm"
  nvm install "$NODE_VERSION"
  nvm alias default 'lts/*' >/dev/null 2>&1 || true
  ok "Node.js $(node -v) ready"
fi

command -v npm >/dev/null 2>&1 || { err "npm not found after Node install. Aborting."; exit 1; }
ok "npm $(npm -v) available"

# ---------- 3. clone or update repo ----------
step "Fetching SkyCode source"
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing install found at $INSTALL_DIR"
  if [ -n "$(git -C "$INSTALL_DIR" status --porcelain 2>/dev/null)" ]; then
    err "Refusing to update: $INSTALL_DIR has uncommitted changes."
    err "Commit/stash your changes, or run with --dir <other-path> for a fresh install."
    exit 1
  fi
  info "Pulling latest main"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout main
  git -C "$INSTALL_DIR" pull origin main
  ok "Repository updated"
elif [ -e "$INSTALL_DIR" ]; then
  err "$INSTALL_DIR exists and is not a git repository. Choose a different --dir."
  exit 1
else
  info "Cloning $REPO_URL into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  ok "Repository cloned"
fi

cd "$INSTALL_DIR"

# ---------- 4. install + build ----------
step "Installing npm dependencies"
npm install
ok "Dependencies installed"

step "Building SkyCode"
npm run build
ok "Build complete"

# ---------- 5. link global command ----------
if [ "$DO_LINK" -eq 1 ]; then
  step "Linking global 'sky' command"
  npm link
  if command -v sky >/dev/null 2>&1; then
    ok "'sky' is on PATH ($(command -v sky))"
  else
    warn "'sky' was linked but is not yet on PATH in this shell."
    warn "Open a new terminal, or run: hash -r"
  fi
else
  info "Skipping npm link (--no-link passed). Run 'node dist/index.js' from $INSTALL_DIR to start SkyCode."
fi

# ---------- 6. summary ----------
step "Install complete"
echo "Location:      $INSTALL_DIR"
echo "Node.js:       $(node -v)"
echo "npm:           $(npm -v)"
[ "$DO_LINK" -eq 1 ] && echo "Command:       sky (or sky-code)"
echo
echo "Next steps:"
echo "  1. Run the setup wizard:   sky setup"
echo "  2. Verify everything:      sky diagnose"
echo "  3. Start SkyCode:          sky"
echo
echo "How to check it worked:"
echo "  command -v sky   # should print a path"
echo "  sky diagnose     # should run all 10 checks"
