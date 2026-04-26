#!/usr/bin/env bash
# Manage the matrix-dispatch launchd service on macOS.
#
# Usage:
#   scripts/launchd.sh install    Render plist, load, and start
#   scripts/launchd.sh uninstall  Stop, unload, and remove plist
#   scripts/launchd.sh start      Kickstart the loaded service
#   scripts/launchd.sh stop       Stop the service (stays loaded)
#   scripts/launchd.sh restart    Stop + start
#   scripts/launchd.sh status     Show launchctl print output
#   scripts/launchd.sh logs       Tail stdout + stderr logs
set -euo pipefail

LABEL="${MATRIX_DISPATCH_LABEL:-local.matrix-dispatch}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/src/launchd.plist.template"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
STATE_DIR="$HOME/.local/state/matrix-dispatch"
DOMAIN="gui/$(id -u)"

render_plist() {
  mkdir -p "$(dirname "$PLIST")" "$STATE_DIR"
  sed \
    -e "s|__INSTALL_DIR__|$REPO_DIR|g" \
    -e "s|__CONFIG_PATH__|$REPO_DIR/dispatch.json|g" \
    -e "s|__WORKING_DIR__|$REPO_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$TEMPLATE" > "$PLIST"
  echo "Rendered $PLIST"
}

kill_manual_processes() {
  # Stop any nohup-launched dispatch processes so launchd owns the account
  local pids
  pids="$(pgrep -f "node .*matrix-dispatch/dist/index.js" || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping manual dispatch processes: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 2
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
}

cmd_install() {
  render_plist
  kill_manual_processes
  # Reload if already loaded
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  echo "Installed and started $LABEL"
  echo "Logs: $STATE_DIR/{stdout,stderr}.log"
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  if [[ -f "$PLIST" ]]; then
    rm -f "$PLIST"
    echo "Removed $PLIST"
  fi
  echo "Uninstalled $LABEL"
}

cmd_start()   { launchctl kickstart "$DOMAIN/$LABEL"; echo "Started $LABEL"; }
cmd_stop()    { launchctl kill SIGTERM "$DOMAIN/$LABEL" 2>/dev/null || true; echo "Stopped $LABEL"; }
cmd_restart() { launchctl kickstart -k "$DOMAIN/$LABEL"; echo "Restarted $LABEL"; }
cmd_status()  { launchctl print "$DOMAIN/$LABEL" 2>&1 | head -40; }
cmd_logs()    { tail -n 100 -f "$STATE_DIR/stdout.log" "$STATE_DIR/stderr.log"; }

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
