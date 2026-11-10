#!/usr/bin/env bash
# Run against a built git-ai v0.4.2 checkout; see the report for build overrides.
set -euo pipefail

export TMPDIR=$HOME/workspace/.tmp
mkdir -p "$TMPDIR"
source_dir=$(cd "${1:?usage: open-scion.sh PINNED_SOURCE_DIR}" && pwd)
probe_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test "$(git -C "$source_dir" rev-parse HEAD)" = a17ad0f7f489ddcfd08c0ecde7e4bd975cb2c2b6
git -C "$source_dir" diff --quiet
git -C "$source_dir" diff --cached --quiet
for tool in gitaly graft; do
  test -x "$source_dir/_build/bin/$tool" || {
    printf 'Missing built binary: %s\n' "$tool" >&2
    exit 1
  }
done
printf 'git-ai source: %s (tracked files clean)\n' "$(git -C "$source_dir" rev-parse HEAD)"
"$source_dir/_build/bin/gitaly" --version
work=$(mktemp -d "$TMPDIR/graft-fixture.XXXXXX")
printf 'Local evidence directory: %s\n' "$work"
mkdir -p "$work"/{repos,run,tokens}
export PATH="$source_dir/_build/bin:$PATH"
server_pid=
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for agent in planner builder; do
  openssl rand -hex 32 > "$work/tokens/$agent"
  chmod 0600 "$work/tokens/$agent"
done
# Use the documented standalone configuration and policy, scoped to this fixture.
sed -e "s|/var/lib/graft/bin|$source_dir/_build/bin|g" \
    -e "s|/var/lib/graft/run|$work/run|g" \
    -e "s|/var/lib/graft/repos|$work/repos|g" \
    -e "s|/etc/graft/tokens|$work/tokens|g" \
    "$source_dir/examples/graft/config.toml" > "$work/config.toml"
start_server() {
  gitaly serve "$work/config.toml" >> "$work/server.log" 2>&1 &
  server_pid=$!
  for _ in $(seq 100); do
    if [ -S "$work/run/gitaly.sock" ]; then return; fi
    kill -0 "$server_pid" 2>/dev/null || { cat "$work/server.log"; return 1; }
    sleep 0.1
  done
  return 1
}
start_server
export GRAFT_ADDRESS="unix:$work/run/gitaly.sock" GRAFT_STORAGE=default
export GRAFT_USER=planner GRAFT_AUTHOR='Fixture Author <fixture@example.invalid>'
GRAFT_TOKEN=change-me-shared-token graft repo create fixture.git --initial-commit
export GRAFT_TOKEN="$(cat "$work/tokens/planner")"
graft clone "$GRAFT_ADDRESS" fixture.git "$work/checkout" --branch main
cd "$work/checkout"
printf 'alpha\n' > README.md
mkdir docs
printf 'fixture\n' > docs/info.txt
graft commit -m 'Fixture base' --land main
base=$(git --git-dir="$work/repos/fixture.git" rev-parse refs/heads/main)
graft cat "$base:README.md"
printf 'beta\n' > README.md
graft diff
graft commit -m 'Fixture candidate' --land main
head=$(git --git-dir="$work/repos/fixture.git" rev-parse refs/heads/main)
graft cat "$base:README.md"
graft cat "$head:README.md"
graft status

cd "$source_dir"
go run "$probe_dir/open-scion-probe.go" denied "$base" "$head" "$work/rpc.patch"
cleanup
server_pid=
# RawDiff is documented but is outside the default agent RPC allowlist.
sed '/^standalone = true/a agent_rpcs = ["/gitaly.DiffService/RawDiff"]' \
  "$work/config.toml" > "$work/config-next.toml"
mv "$work/config-next.toml" "$work/config.toml"
start_server
go run "$probe_dir/open-scion-probe.go" allowed "$base" "$head" "$work/rpc.patch"
git --git-dir="$work/repos/fixture.git" diff --full-index "$base" "$head" > "$work/git.patch"
cmp "$work/git.patch" "$work/rpc.patch"
printf 'RPC patch matches independent git diff\n'
