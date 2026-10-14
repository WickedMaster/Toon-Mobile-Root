#!/bin/sh
# Bouwt een opkg-pakket (.ipk) uit p1/package of ha/package.
# Gebruik: tools/build-ipk.sh p1|ha    (de versie komt uit Version: in package/c/control)
set -e
V=${1:?gebruik: build-ipk.sh p1|ha}
cd "$(dirname "$0")/../$V/package"
NAME=$(sed -n 's/^Package: //p' c/control)
VER=$(sed -n 's/^Version: //p' c/control)
rm -rf ../../.build && mkdir -p ../../.build
printf '2.0\n' > ../../.build/debian-binary
tar czf ../../.build/control.tar.gz --owner=0 --group=0 -C c .
tar czf ../../.build/data.tar.gz --owner=0 --group=0 -C d .
REL="../../releases/${VER%-r*}"; mkdir -p "$REL"
OUT="$REL/${NAME}_$(echo "$VER" | tr . _)_all.ipk"
(cd ../../.build && ar rc out.ipk debian-binary control.tar.gz data.tar.gz)
mv ../../.build/out.ipk "$OUT"
rm -rf ../../.build
echo "gebouwd: $OUT"
