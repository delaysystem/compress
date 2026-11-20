#!/bin/bash
# push.sh <kernel-dir> — stamp phone-home URL+token into a COPY and push it.
# Repo files keep TUNNEL=''/TOKEN='' placeholders: no secrets ever in git.
# Fails loudly when the tunnel is down or the notebook lacks the helper —
# it never pushes an unstamped kernel silently.
set -ue
stamp_only=0
[ "${1:-}" = "--stamp-only" ] && { stamp_only=1; shift; }
dir="${1:?usage: push.sh [--stamp-only] <kernel-dir>}"
[ -f /tmp/phonehome/url ] && [ -f /tmp/phonehome/token ] \
  || { echo 'PHONEHOME_DOWN: deploy receiver+tunnel first (see README)'; exit 1; }
url=$(cat /tmp/phonehome/url); token=$(cat /tmp/phonehome/token)
curl -s --max-time 15 "$url/health" | grep -q ok \
  || { echo 'PHONEHOME_DOWN: tunnel health check failed'; exit 1; }
meta="$dir/kernel-metadata.json"
code=$(python3 -c "import json; print(json.load(open('$meta'))['code_file'])")
grep -q 'TUNNEL = ' "$dir/$code" \
  || { echo "NO_PLACEHOLDER: $code lacks the phone-home helper (copy phonehome/hb.py block, set KID)"; exit 1; }
work=/tmp/push-stamped; rm -rf "$work"; cp -r "$dir" "$work"
python3 - "$work/$code" "$url" "$token" <<'EOF'
import json, sys
p, url, token = sys.argv[1], sys.argv[2], sys.argv[3]
nb = json.load(open(p))
n = 0
for c in nb['cells']:
    if c['cell_type'] != 'code':
        continue
    src = ''.join(c['source'])
    if 'TUNNEL = ""' in src:
        src = src.replace('TUNNEL = ""', f"TUNNEL = '{url}'", 1)
        src = src.replace('TOKEN = ""', f"TOKEN = '{token}'", 1)
        n += 1
        lines = src.split('\n')
        c['source'] = [ln + '\n' for ln in lines[:-1]] + ([lines[-1]] if lines[-1] else [])
    compile(''.join(c['source']), 'x', 'exec')
assert n == 1, n
json.dump(nb, open(p, 'w'))
print('stamped + valid:', p)
EOF
if [ "$stamp_only" = 1 ]; then echo "STAMPED (not pushed): $work"; else kaggle kernels push -p "$work"; fi
