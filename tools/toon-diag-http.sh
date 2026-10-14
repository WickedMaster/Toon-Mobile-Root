#!/bin/sh
# toon-diag-http.sh - test of deze Toon een weekprogramma via HTTP (zonder helper) aanneemt.
# Doet: 1 blokgrens 10 minuten opschuiven, kijken of de Toon het overneemt, daarna terugzetten.
# Doet dit 2x: met en zonder type-attribuut in de xml. Uitvoer ook in /tmp/http-diag.txt
BASE=http://localhost
PURL="$BASE/hcb_config?action=getObjectConfigTree&package=happ_thermstat&internalAddress=thermostatProgram"
IURL="$BASE/happ_thermstat?action=getThermostatInfo"
OUT=/tmp/http-diag.txt

get() { curl -s -m 8 "$1"; }
rid() { get "$IURL" | sed -n 's/.*"randomConfigId" *: *"\([-0-9]*\)".*/\1/p'; }

entries_from_json() {
    sed 's/}/}\
/g' | grep '"startDayOfWeek"' | awk '
    { if (match($0, "\"type\"[ ]*:[ ]*\\[[ ]*\"[a-z_]+\"")) {
        t = substr($0, RSTART, RLENGTH); sub(/^.*\[[ ]*"/, "", t); sub(/"$/, "", t)
        if (t != "weekly_recurring") next
      }
      ok = 1; line = ""
      n = split("startDayOfWeek startHour startMin endDayOfWeek endHour endMin targetState", K, " ")
      for (i = 1; i <= n; i++) {
        if (match($0, "\"" K[i] "\"[ ]*:[ ]*\\[[ ]*\"[0-9]+\"")) {
          s = substr($0, RSTART, RLENGTH); sub(/^"[A-Za-z]+"/, "", s); gsub(/[^0-9]/, "", s)
          v = s + 0; sep = (i > 1) ? "," : ""; line = line sep v
        } else ok = 0
      }
      if (ok) print line
    }' | sort
}

# lijst regels -> dezelfde lijst met 1 grens 10 min later (blokken blijven >= 30 min)
shift_one() {
    awk -F, -v W=10080 '
    { S[NR]=$1*1440+$2*60+$3; E[NR]=$4*1440+$5*60+$6; T[NR]=$7; if (E[NR]<=S[NR]) E[NR]+=W; n=NR }
    END {
      done=0
      for (i=1;i<=n && !done;i++) { li=E[i]-S[i]
        for (j=1;j<=n;j++) if (j!=i && (E[i]%W)==(S[j]%W)) { lj=E[j]-S[j]
          if (li>=40 && lj>=40) { E[i]+=10; S[j]=(S[j]+10)%W; done=1; break } } }
      if (!done) { print "GEEN"; exit }
      for (i=1;i<=n;i++) { s=S[i]%W; e=E[i]%W
        printf "%d,%d,%d,%d,%d,%d,%d\n", int(s/1440), int((s%1440)/60), s%60, int(e/1440), int((e%1440)/60), e%60, T[i] }
    }'
}

put() {   # $1 = 1 met type-attribuut, 0 zonder; $2 = regels
    x=$(printf '%s\n' "$2" | awk -F, -v A="$1" '{
        if (A == 1) printf "<entry type=\"weekly_recurring\">"; else printf "<entry>"
        printf "<type>weekly_recurring</type><startMin>%d</startMin><startHour>%d</startHour><startDayOfWeek>%d</startDayOfWeek><targetState>%d</targetState><endMin>%d</endMin><endHour>%d</endHour><endDayOfWeek>%d</endDayOfWeek></entry>", $3,$2,$1,$7,$6,$5,$4 }')
    full="<Config><device><uuid>$UUID</uuid><schedule>${x}</schedule><type>program</type><visibility>1</visibility><package>happ_thermstat</package><internalAddress>thermostatProgram</internalAddress></device></Config>"
    curl -s -m 10 -G --data-urlencode "config=$full" "$BASE/hcb_config?action=setObjectConfig"
}

wait_for() {  # $1 = verwachte regels; 8 s
    n=0
    while [ $n -lt 8 ]; do
        sleep 1; n=$((n+1))
        [ "$(get "$PURL" | entries_from_json)" = "$1" ] && return 0
    done
    return 1
}

run() {
    echo "== Toon-test HTTP-schrijven ($(date))"
    echo "host: $(hostname)  kernel: $(uname -r)"
    for f in /etc/version /etc/release /qmf/etc/version /HCBv2/etc/version; do [ -r $f ] && echo "$f: $(head -c 120 $f | tr '\n' ' ')"; done
    opkg list-installed 2>/dev/null | grep -E '^(hcb|happ|base-files|toon|tsc|qt-gui|qtqml)' | head -n 12

    J=$(get "$PURL")
    [ -n "$J" ] || { echo "FOUT: geen antwoord van $PURL"; return; }
    case "$J" in *holiday*) echo "STOP: er staat een vakantie in het programma; eerst uitzetten en opnieuw proberen."; return ;; esac
    UUID=$(printf '%s' "$J" | sed -n 's/.*"uuid" *: *\[ *"\([^"]*\)".*/\1/p' | head -n 1)
    [ -n "$UUID" ] || { echo "FOUT: geen uuid in het programma gevonden"; return; }
    ORIG=$(printf '%s' "$J" | entries_from_json)
    echo "huidig programma: $(printf '%s\n' "$ORIG" | grep -c .) blokken, uuid $UUID"
    printf '%s\n' "$J" > /tmp/http-diag-orig.json
    NEWL=$(printf '%s\n' "$ORIG" | shift_one)
    [ "$NEWL" = "GEEN" ] && { echo "STOP: geen geschikte blokgrens om te testen"; return; }
    WANT=$(printf '%s\n' "$NEWL" | sort)

    for A in 1 0; do
        [ $A = 1 ] && label="MET type-attribuut" || label="ZONDER type-attribuut (zoals de app)"
        echo; echo "-- test $label"
        r0=$(rid)
        echo "antwoord Toon: $(put $A "$NEWL")"
        if wait_for "$WANT"; then echo "A. schema in de config veranderd: JA"; stored=1; else echo "A. schema in de config veranderd: NEE (de Toon negeert dit)"; stored=0; fi
        n=0; r1=$r0
        while [ $n -lt 6 ]; do sleep 1; n=$((n+1)); r1=$(rid); [ "$r1" != "$r0" ] && break; done
        if [ "$r1" != "$r0" ]; then echo "B. thermostaat nam het over (randomConfigId $r0 -> $r1): JA"; else echo "B. thermostaat nam het over: NEE (randomConfigId bleef $r0)"; fi
        if [ $stored = 1 ]; then
            echo "terugzetten: $(put $A "$ORIG")"
            if wait_for "$(printf '%s\n' "$ORIG")"; then echo "terugzetten gelukt: JA"; else echo "LET OP: terugzetten NIET gelukt. Zet het programma terug met 'Vorig programma terugzetten' in de app."; return; fi
        fi
    done
    echo; echo "== klaar. Stuur deze uitvoer terug (staat ook in $OUT)"
}
run 2>&1 | tee $OUT
