#!/bin/bash
# Batch-test sample invoices through the live AI parser.
# Usage: ./scripts/test-samples.sh [hospital_id]     (default: mithra)
# Drop invoices (PDF/JPG/PNG) into /root/yajna-pharma/samples/ first.

set -u
HID="${1:-mithra}"
BASE="http://127.0.0.1:3060"
SAMPLES="/root/yajna-pharma/samples"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# Credentials come from the environment. There is deliberately no default —
# a password with a fallback in a script is a password in the repository.
ADMIN_EMAIL="${YPS_ADMIN_EMAIL:-bhagavan@yajnapharma.in}"
if [ -z "${YPS_ADMIN_PW:-}" ]; then
  echo "Set YPS_ADMIN_PW first:  YPS_ADMIN_PW='...' $0 $*" >&2; exit 1
fi
ADMIN_PW="$YPS_ADMIN_PW"

login=$(curl -s -c "$JAR" -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}")
if ! echo "$login" | grep -q '"user"'; then
  echo "Login failed: $login" >&2; exit 1
fi

shopt -s nullglob nocaseglob
files=("$SAMPLES"/*.pdf "$SAMPLES"/*.jpg "$SAMPLES"/*.jpeg "$SAMPLES"/*.png "$SAMPLES"/*.webp)
if [ ${#files[@]} -eq 0 ]; then
  echo "No invoices found in $SAMPLES (looking for .pdf/.jpg/.jpeg/.png/.webp)" >&2; exit 1
fi

echo "Parsing ${#files[@]} sample invoice(s) for hospital '$HID'..."
echo
for f in "${files[@]}"; do
  echo "=============================================================="
  echo "FILE: $(basename "$f")  ($(du -h "$f" | cut -f1))"
  echo "--------------------------------------------------------------"
  start=$(date +%s)
  resp=$(curl -s -b "$JAR" -X POST "$BASE/api/parse/invoice?hid=$HID" -F "file=@$f")
  dur=$(( $(date +%s) - start ))
  echo "$resp" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  let r; try{ r=JSON.parse(d); }catch(e){ console.log('  RAW:', d.slice(0,400)); process.exit(0); }
  if(r.error){ console.log('  ERROR:', r.error); return; }
  console.log('  Vendor  :', r.vendor||'(none)');
  console.log('  Invoice#:', r.invoiceNo||'(none)', '  Date:', r.date||'(none)');
  console.log('  Lines   :', r.lines.length);
  const tot = r.lines.reduce((a,l)=>a+(+l.value||0),0);
  console.log('  Total   : Rs.', Math.round(tot).toLocaleString('en-IN'));
  console.log('');
  const pad=(s,n)=>String(s).padEnd(n).slice(0,n);
  const padl=(s,n)=>String(s).padStart(n);
  console.log('  '+pad('Item',34)+padl('Qty',5)+padl('NR',10)+padl('MRP',10)+padl('Value',11)+padl('Given%',8)+padl('Mast%',8)+'  Status');
  r.lines.forEach(l=>{
    console.log('  '+pad(l.item,34)+padl(l.qty,5)+padl(l.nr,10)+padl(l.mrp,10)+padl(Math.round(l.value),11)
      +padl(l.givenMargin!=null? l.givenMargin+'%':'-',8)
      +padl(l.expectedMargin!=null? l.expectedMargin+'%':'-',8)+'  '+l.status);
  });
});
"
  echo "  (parsed in ${dur}s)"
  echo
done
echo "=============================================================="
echo "Done. Check that Item / Qty / NR (incl GST) / MRP match each invoice."
