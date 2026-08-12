/**
 * i18n-content.js
 * The inspection forms, in German.
 *
 * These strings do not belong to the frontend. Section titles, question labels,
 * help text and option labels live in the Schemas sheet, are seeded from
 * gas/SchemaSeed.gs, and arrive with every getInspection. English is their
 * source language, so this maps the English the server sends to the German the
 * screen shows — see tc() in i18n.js.
 *
 * Why a map keyed by the English text rather than by item id:
 *
 *  - The sheet is editable. An admin who adds a question gets it rendered as
 *    they typed it instead of a missing key or a blank label. Nothing here can
 *    make a schema fail to display.
 *  - The seeded schemas reuse the same labels across five inspection types
 *    ("Wall condition" appears in every room of every schema), so one entry
 *    covers all of them.
 *
 * The cost is that one English string can only have one German translation,
 * whatever context it appears in. That is fine for this vocabulary and would
 * not be for a larger one; if it ever bites, the fix is a per-schema map, not
 * a cleverer lookup.
 *
 * tests/i18n.test.js reads gas/SchemaSeed.gs and fails if a seeded string has
 * no entry here — which is what stops a question added to the seed from
 * quietly showing up in English on a German screen.
 *
 * Swiss German, so: no "ß", and Swiss words where they differ — Lavabo, not
 * Waschbecken; Boiler, not Warmwasserspeicher; Dampfabzug, not
 * Dunstabzugshaube; Mietzinsdepot, not Kaution; Plättli, not Fliesen.
 */

const de = {
  // --- Condition scale, used by every room ---
  'Excellent': 'Sehr gut',
  'Good': 'Gut',
  'Fair': 'Genügend',
  'Damaged': 'Beschädigt',

  // --- General information ---
  'General Information': 'Allgemeine Angaben',
  'Basic information about the inspection.': 'Grundangaben zur Abnahme.',
  'Inspector name': 'Name der abnehmenden Person',
  'Inspection date': 'Datum der Abnahme',
  'Persons present': 'Anwesende Personen',
  'Weather conditions': 'Witterung',
  'Clear': 'Sonnig',
  'Rainy': 'Regnerisch',
  'Cold': 'Kalt',
  'Hot': 'Heiss',

  // --- Keys ---
  'Keys': 'Schlüssel',
  'Number of keys handed over': 'Anzahl übergebener Schlüssel',
  'Key types and labels': 'Schlüsselarten und Beschriftung',
  'Number of remote/access cards': 'Anzahl Fernbedienungen / Badges',
  'Mailbox key included': 'Briefkastenschlüssel enthalten',
  'Garage/parking key included': 'Garagen-/Parkplatzschlüssel enthalten',
  'Notes about keys': 'Bemerkungen zu den Schlüsseln',

  // --- Meters ---
  'Meters': 'Zählerstände',
  'Electricity meter reading (kWh)': 'Stromzählerstand (kWh)',
  'Electricity meter serial number': 'Zählernummer Strom',
  'Cold water meter reading (m³)': 'Kaltwasserzähler (m³)',
  'Hot water meter reading (m³)': 'Warmwasserzähler (m³)',
  'Gas meter reading (m³)': 'Gaszähler (m³)',
  'Central heating reading': 'Ablesung Zentralheizung',
  'Notes about meters': 'Bemerkungen zu den Zählern',

  // --- Rooms ---
  'Entryway / Hall': 'Eingang / Korridor',
  'Living Room': 'Wohnzimmer',
  'Bedroom 1': 'Schlafzimmer 1',
  'Bedroom 2 (if present)': 'Schlafzimmer 2 (falls vorhanden)',
  'Wall condition': 'Zustand Wände',
  'Wall notes': 'Bemerkungen Wände',
  'Floor condition': 'Zustand Boden',
  'Floor notes': 'Bemerkungen Boden',
  'Ceiling condition': 'Zustand Decke',
  'Windows condition': 'Zustand Fenster',
  'Doors condition': 'Zustand Türen',
  'Lighting working': 'Beleuchtung funktioniert',
  'All working': 'Alles funktioniert',
  'Some not working': 'Teilweise defekt',
  'None working': 'Nichts funktioniert',
  'General notes for this room': 'Allgemeine Bemerkungen zu diesem Raum',

  // --- Kitchen ---
  'Kitchen': 'Küche',
  'Cabinets condition': 'Zustand Schränke',
  'Countertop condition': 'Zustand Arbeitsfläche',
  'Sink and faucet condition': 'Zustand Spültrog und Armatur',
  'Appliances present': 'Vorhandene Geräte',
  'Refrigerator': 'Kühlschrank',
  'Oven': 'Backofen',
  'Cooktop': 'Kochfeld',
  'Microwave': 'Mikrowelle',
  'Dishwasher': 'Geschirrspüler',
  'Range hood': 'Dampfabzug',
  'All listed appliances working': 'Alle aufgeführten Geräte funktionieren',
  'Kitchen notes': 'Bemerkungen Küche',

  // --- Bathroom ---
  'Main Bathroom': 'Bad / Nasszelle',
  'Wall tiles condition': 'Zustand Wandplättli',
  'Toilet condition': 'Zustand WC',
  'Sink condition': 'Zustand Lavabo',
  'Shower/bathtub condition': 'Zustand Dusche / Badewanne',
  'Ventilation working': 'Entlüftung funktioniert',
  'Water pressure': 'Wasserdruck',
  'Low': 'Schwach',
  'None': 'Kein Druck',
  'Bathroom notes': 'Bemerkungen Bad',

  // --- Appliances and equipment ---
  'Other Appliances and Equipment': 'Weitere Geräte und Einrichtungen',
  'Washing machine': 'Waschmaschine',
  'Not present': 'Nicht vorhanden',
  'Working': 'Funktioniert',
  'Water heater / boiler': 'Wassererwärmer / Boiler',
  'Electric — working': 'Elektrisch — funktioniert',
  'Gas — working': 'Gas — funktioniert',
  'Central building heating': 'Zentralheizung der Liegenschaft',
  'Damaged / not working': 'Beschädigt / funktioniert nicht',
  'Number of A/C units': 'Anzahl Klimageräte',
  'All A/C units working': 'Alle Klimageräte funktionieren',
  'Smoke detector present and working': 'Rauchmelder vorhanden und funktionsfähig',
  'Notes': 'Bemerkungen',

  // --- Damages ---
  'Damages and Remarks': 'Schäden und Bemerkungen',
  'Damages observed': 'Festgestellte Schäden',
  'Overall severity': 'Gesamtschwere',
  'Minor (cosmetic)': 'Gering (optisch)',
  'Moderate (functional but acceptable)': 'Mittel (funktionsfähig, aber akzeptabel)',
  'Major (requires repair)': 'Erheblich (Reparatur nötig)',
  'Critical (safety/habitability)': 'Kritisch (Sicherheit / Bewohnbarkeit)',
  'Detailed description of damages': 'Ausführliche Beschreibung der Schäden',
  'Responsible party': 'Verantwortliche Partei',
  'Tenant': 'Mieterschaft',
  'Landlord': 'Vermieterschaft',
  'Shared / unclear': 'Geteilt / unklar',
  'Normal wear and tear': 'Normale Abnutzung',
  'Estimated repair cost': 'Geschätzte Reparaturkosten',

  // --- Final notes ---
  'Final Notes and Agreements': 'Schlussbemerkungen und Vereinbarungen',
  'Overall property state': 'Gesamtzustand des Objekts',
  'Acceptable': 'In Ordnung',
  'Needs attention': 'Handlungsbedarf',
  'Unacceptable': 'Nicht in Ordnung',
  'Special agreements between parties': 'Besondere Vereinbarungen zwischen den Parteien',
  'Outstanding issues to address': 'Offene Punkte zur Erledigung',
  'Inspector remarks': 'Bemerkungen der abnehmenden Person',

  // --- Schema titles ---
  'Move-in Inspection': 'Wohnungsübergabe (Einzug)',
  'Move-out Inspection': 'Wohnungsabnahme (Auszug)',
  'Periodic Inspection': 'Periodische Kontrolle',
  'Damage Report': 'Schadenmeldung',
  'Key Handover': 'Schlüsselübergabe',

  // --- Move-out: cleaning and deposit ---
  'Cleaning': 'Reinigung',
  'Overall cleanliness': 'Gesamteindruck der Reinigung',
  'Professionally cleaned': 'Professionell gereinigt',
  'Inadequate': 'Ungenügend',
  'Areas requiring re-cleaning': 'Bereiche, die nachgereinigt werden müssen',
  'Deposit Settlement': 'Abrechnung Mietzinsdepot',
  'Original deposit amount': 'Ursprüngliches Mietzinsdepot',
  'Total deductions': 'Total der Abzüge',
  'Amount to be returned': 'Rückzuerstattender Betrag',
  'Explanation of deductions': 'Begründung der Abzüge',

  // --- Periodic: maintenance ---
  'Maintenance Items': 'Unterhaltspunkte',
  'Smoke detectors tested and working': 'Rauchmelder geprüft und funktionsfähig',
  'A/C filters checked': 'Filter der Klimageräte kontrolliert',
  'Drains running freely': 'Abläufe laufen frei',
  'No signs of pest infestation': 'Keine Anzeichen von Schädlingsbefall',
  'Pest details': 'Angaben zum Schädlingsbefall',

  // --- Damage report ---
  'Damage Event Details': 'Angaben zum Schadenereignis',
  'Date of damage event': 'Datum des Schadenereignisses',
  'Cause': 'Ursache',
  'Water leak': 'Wasserschaden',
  'Fire': 'Feuer',
  'Storm / weather': 'Sturm / Unwetter',
  'Vandalism': 'Vandalismus',
  'Tenant negligence': 'Fahrlässigkeit der Mieterschaft',
  'Wear and tear': 'Abnutzung',
  'Other': 'Anderes',
  'Specify other cause': 'Andere Ursache angeben',
  'Detailed description': 'Ausführliche Beschreibung',
  'Insurance and Resolution': 'Versicherung und Erledigung',
  'Insurance claim filed': 'Schaden bei der Versicherung gemeldet',
  'Claim number': 'Schadennummer',
  'Repair / resolution plan': 'Reparatur- / Erledigungsplan',
  'Responsible for repair': 'Verantwortlich für die Reparatur',
  'Insurance': 'Versicherung',
  'Shared': 'Geteilt',

  // --- Key handover ---
  'Access Codes and Credentials': 'Zugangscodes und Zugangsdaten',
  'Alarm system code (handover)': 'Code der Alarmanlage (Übergabe)',
  'Building entry code': 'Code für den Hauseingang',
  'Wi-Fi credentials provided': 'WLAN-Zugangsdaten übergeben',
  'Other access notes': 'Weitere Bemerkungen zum Zugang',
};

/** English needs no map — it is the language the schemas are written in. */
export const CONTENT = { de };
