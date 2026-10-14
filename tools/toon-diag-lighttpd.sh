(echo "== lighttpd proces"; ps | grep lighttpd | grep -v grep
 echo "== conf op schijf: svg en auth"; grep -n '"\.svg"\|^auth.require' /HCBv2/etc/lighttpd/lighttpd.conf
 echo "== backups/orig"; ls -l /HCBv2/etc/lighttpd/
 echo "== opkg"; opkg list-installed | grep -i tsctoon
 echo "== is conf gelijk aan die van het pakket?"; cmp /HCBv2/etc/lighttpd/lighttpd.conf /HCBv2/qml/apps/tsctoonmobile/lighttpd.conf && echo gelijk) > /tmp/conf.txt 2>&1
