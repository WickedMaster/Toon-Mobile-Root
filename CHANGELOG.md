# Wijzigingen

## 2.0.0
Eerste genummerde release; app en pakket delen één nummer.

- Vakantiestand (Meer > Vakantie): periode en temperatuur instellen, banner op Home met "Zet uit".
- Programma bekijken en wijzigen (blok toevoegen/wijzigen/verwijderen, dag kopiëren, vorig programma terugzetten) en vakantiestand worden rechtstreeks op de Toon gezet en gecontroleerd (teruglezen + thermostaat neemt het over). Back-up van het vorige programma in de app. Getest op Toon 2-software 6.4.5 en op een echte Toon 2.
- Dagtotalen (Stroom/Gas/Opwek vandaag) tonen een streepje in plaats van een negatief getal vlak na het koppelen van de meetmodule.
- P1-pakket: inlog voor `/mobile`, zelfstandig en terugdraaibaar.
- Namen "Toon" en "Toon (HA)"; nieuwe pictogrammen (thermostaat met huisje; P1 oranje, HA blauw).
- Reservewaarden balken: stroom nu 2500 W, stroom vandaag 18 kWh, gas 5.
- "uit tellers" verwijderd onder stroom- en productie vandaag.
- HA-pagina: standaardpictogrammen in de pagina ingebouwd (niet afhankelijk van het mimetype van de webserver); `ha-config.js` altijd vers opgehaald.
- P1-app: ondertitel van Instellingen noemt Home Assistant niet meer.
