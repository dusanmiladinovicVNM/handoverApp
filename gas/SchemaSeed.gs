/**
 * SchemaSeed.gs
 * Seed schemas for all 5 inspection types.
 * Loaded into the Schemas sheet by loadInitialSchemas() in BootstrapService.gs.
 *
 * Schema items support these types: text, textarea, number, date,
 *   checkbox, select, multiselect, radio.
 * Conditional logic: visibleWhen, requiredWhen with operators
 *   equals, notEquals, in, notIn, truthy, falsy, plus all/any combinators.
 */

const SchemaSeed = (function () {

  // --- Reusable section builders ---

  const CONDITION_OPTIONS = [
    { value: 'excellent', label: 'Excellent' },
    { value: 'good',      label: 'Good' },
    { value: 'fair',      label: 'Fair' },
    { value: 'damaged',   label: 'Damaged' },
  ];

  function generalInfoSection() {
    return {
      id: 'general',
      title: 'General Information',
      description: 'Basic information about the inspection.',
      items: [
        { id: 'general_inspector_name', type: 'text', label: 'Inspector name', required: true },
        { id: 'general_inspection_date', type: 'date', label: 'Inspection date', required: true },
        { id: 'general_present_parties', type: 'textarea', label: 'Persons present', required: false },
        { id: 'general_weather', type: 'select', label: 'Weather conditions', required: false,
          options: [
            { value: 'clear', label: 'Clear' },
            { value: 'rainy', label: 'Rainy' },
            { value: 'cold', label: 'Cold' },
            { value: 'hot', label: 'Hot' },
          ]
        },
      ],
    };
  }

  function keysSection() {
    return {
      id: 'keys',
      title: 'Keys',
      items: [
        { id: 'keys_count', type: 'number', label: 'Number of keys handed over', required: true },
        { id: 'keys_types', type: 'textarea', label: 'Key types and labels',
          required: false,
          attachments: { enabled: true, max: 3 } },
        { id: 'keys_remote_count', type: 'number', label: 'Number of remote/access cards', required: false },
        { id: 'keys_mailbox_key', type: 'checkbox', label: 'Mailbox key included' },
        { id: 'keys_garage_key', type: 'checkbox', label: 'Garage/parking key included' },
        { id: 'keys_notes', type: 'textarea', label: 'Notes about keys' },
      ],
    };
  }

  function metersSection() {
    return {
      id: 'meters',
      title: 'Meters',
      items: [
        { id: 'meter_electricity_reading', type: 'number', label: 'Electricity meter reading (kWh)', required: true,
          attachments: { enabled: true, min: 1, max: 2 } },
        { id: 'meter_electricity_number', type: 'text', label: 'Electricity meter serial number' },
        { id: 'meter_water_cold_reading', type: 'number', label: 'Cold water meter reading (m³)', required: true,
          attachments: { enabled: true, min: 1, max: 2 } },
        { id: 'meter_water_hot_reading', type: 'number', label: 'Hot water meter reading (m³)',
          attachments: { enabled: true, max: 2 } },
        { id: 'meter_gas_reading', type: 'number', label: 'Gas meter reading (m³)',
          attachments: { enabled: true, max: 2 } },
        { id: 'meter_heating_reading', type: 'text', label: 'Central heating reading',
          attachments: { enabled: true, max: 2 } },
        { id: 'meter_notes', type: 'textarea', label: 'Notes about meters' },
      ],
    };
  }

  function roomConditionSection(id, title) {
    return {
      id: id,
      title: title,
      items: [
        { id: `${id}_walls`, type: 'select', label: 'Wall condition', required: true,
          options: CONDITION_OPTIONS,
          attachments: { enabled: true, max: 5 } },
        { id: `${id}_walls_notes`, type: 'textarea', label: 'Wall notes',
          visibleWhen: { field: `${id}_walls`, operator: 'in', value: ['fair', 'damaged'] },
          requiredWhen: { field: `${id}_walls`, operator: 'equals', value: 'damaged' } },

        { id: `${id}_floor`, type: 'select', label: 'Floor condition', required: true,
          options: CONDITION_OPTIONS,
          attachments: { enabled: true, max: 5 } },
        { id: `${id}_floor_notes`, type: 'textarea', label: 'Floor notes',
          visibleWhen: { field: `${id}_floor`, operator: 'in', value: ['fair', 'damaged'] },
          requiredWhen: { field: `${id}_floor`, operator: 'equals', value: 'damaged' } },

        { id: `${id}_ceiling`, type: 'select', label: 'Ceiling condition', required: true,
          options: CONDITION_OPTIONS,
          attachments: { enabled: true, max: 3 } },

        { id: `${id}_windows`, type: 'select', label: 'Windows condition', required: true,
          options: CONDITION_OPTIONS,
          attachments: { enabled: true, max: 3 } },

        { id: `${id}_doors`, type: 'select', label: 'Doors condition', required: true,
          options: CONDITION_OPTIONS,
          attachments: { enabled: true, max: 3 } },

        { id: `${id}_lighting`, type: 'select', label: 'Lighting working', required: true,
          options: [
            { value: 'all', label: 'All working' },
            { value: 'partial', label: 'Some not working' },
            { value: 'none', label: 'None working' },
          ] },

        { id: `${id}_general_notes`, type: 'textarea', label: 'General notes for this room' },
      ],
    };
  }

  function kitchenSection() {
    return {
      id: 'kitchen',
      title: 'Kitchen',
      items: [
        { id: 'kitchen_cabinets', type: 'select', label: 'Cabinets condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 5 } },
        { id: 'kitchen_countertop', type: 'select', label: 'Countertop condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 3 } },
        { id: 'kitchen_sink', type: 'select', label: 'Sink and faucet condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 3 } },
        { id: 'kitchen_walls', type: 'select', label: 'Wall condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 5 } },
        { id: 'kitchen_floor', type: 'select', label: 'Floor condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 3 } },
        { id: 'kitchen_appliances_present', type: 'multiselect', label: 'Appliances present',
          options: [
            { value: 'fridge', label: 'Refrigerator' },
            { value: 'oven', label: 'Oven' },
            { value: 'cooktop', label: 'Cooktop' },
            { value: 'microwave', label: 'Microwave' },
            { value: 'dishwasher', label: 'Dishwasher' },
            { value: 'extractor', label: 'Range hood' },
          ] },
        { id: 'kitchen_appliances_working', type: 'checkbox', label: 'All listed appliances working',
          visibleWhen: { field: 'kitchen_appliances_present', operator: 'truthy' } },
        { id: 'kitchen_notes', type: 'textarea', label: 'Kitchen notes' },
      ],
    };
  }

  function bathroomSection(id, title) {
    return {
      id: id,
      title: title,
      items: [
        { id: `${id}_tiles`, type: 'select', label: 'Wall tiles condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 5 } },
        { id: `${id}_floor`, type: 'select', label: 'Floor condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 3 } },
        { id: `${id}_toilet`, type: 'select', label: 'Toilet condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 2 } },
        { id: `${id}_sink`, type: 'select', label: 'Sink condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 2 } },
        { id: `${id}_shower`, type: 'select', label: 'Shower/bathtub condition', required: true,
          options: CONDITION_OPTIONS, attachments: { enabled: true, max: 3 } },
        { id: `${id}_ventilation`, type: 'checkbox', label: 'Ventilation working' },
        { id: `${id}_water_pressure`, type: 'select', label: 'Water pressure',
          options: [
            { value: 'good', label: 'Good' },
            { value: 'low', label: 'Low' },
            { value: 'none', label: 'None' },
          ] },
        { id: `${id}_notes`, type: 'textarea', label: 'Bathroom notes' },
      ],
    };
  }

  function appliancesSection() {
    return {
      id: 'appliances',
      title: 'Other Appliances and Equipment',
      items: [
        { id: 'app_washing_machine', type: 'select', label: 'Washing machine', required: false,
          options: [
            { value: 'not_present', label: 'Not present' },
            { value: 'working', label: 'Working' },
            { value: 'damaged', label: 'Damaged' },
          ], attachments: { enabled: true, max: 3 } },
        { id: 'app_water_heater', type: 'select', label: 'Water heater / boiler', required: true,
          options: [
            { value: 'electric_working', label: 'Electric — working' },
            { value: 'gas_working', label: 'Gas — working' },
            { value: 'central', label: 'Central building heating' },
            { value: 'damaged', label: 'Damaged / not working' },
          ], attachments: { enabled: true, max: 2 } },
        { id: 'app_ac_units', type: 'number', label: 'Number of A/C units', required: false },
        { id: 'app_ac_working', type: 'checkbox', label: 'All A/C units working',
          visibleWhen: { field: 'app_ac_units', operator: 'truthy' } },
        { id: 'app_smoke_detector', type: 'checkbox', label: 'Smoke detector present and working' },
        { id: 'app_notes', type: 'textarea', label: 'Notes' },
      ],
    };
  }

  function damagesSection() {
    return {
      id: 'damages',
      title: 'Damages and Remarks',
      items: [
        { id: 'damages_present', type: 'checkbox', label: 'Damages observed' },
        { id: 'damages_severity', type: 'select', label: 'Overall severity',
          visibleWhen: { field: 'damages_present', operator: 'truthy' },
          requiredWhen: { field: 'damages_present', operator: 'truthy' },
          options: [
            { value: 'minor', label: 'Minor (cosmetic)' },
            { value: 'moderate', label: 'Moderate (functional but acceptable)' },
            { value: 'major', label: 'Major (requires repair)' },
            { value: 'critical', label: 'Critical (safety/habitability)' },
          ] },
        { id: 'damages_description', type: 'textarea', label: 'Detailed description of damages',
          visibleWhen: { field: 'damages_present', operator: 'truthy' },
          requiredWhen: { field: 'damages_present', operator: 'truthy' },
          attachments: { enabled: true, max: 10 } },
        { id: 'damages_responsible_party', type: 'select', label: 'Responsible party',
          visibleWhen: { field: 'damages_present', operator: 'truthy' },
          options: [
            { value: 'tenant', label: 'Tenant' },
            { value: 'landlord', label: 'Landlord' },
            { value: 'shared', label: 'Shared / unclear' },
            { value: 'wear', label: 'Normal wear and tear' },
          ] },
        { id: 'damages_estimated_cost', type: 'number', label: 'Estimated repair cost',
          visibleWhen: { field: 'damages_present', operator: 'truthy' } },
      ],
    };
  }

  function finalNotesSection() {
    return {
      id: 'final_notes',
      title: 'Final Notes and Agreements',
      items: [
        { id: 'final_overall_state', type: 'select', label: 'Overall property state', required: true,
          options: [
            { value: 'excellent', label: 'Excellent' },
            { value: 'good', label: 'Good' },
            { value: 'acceptable', label: 'Acceptable' },
            { value: 'needs_attention', label: 'Needs attention' },
            { value: 'unacceptable', label: 'Unacceptable' },
          ] },
        { id: 'final_special_agreements', type: 'textarea', label: 'Special agreements between parties' },
        { id: 'final_outstanding_issues', type: 'textarea', label: 'Outstanding issues to address' },
        { id: 'final_inspector_remarks', type: 'textarea', label: 'Inspector remarks' },
      ],
    };
  }

  // --- Schema assemblers ---

  function moveInSchema() {
    return {
      schemaVersion: 1,
      inspectionType: 'move_in',
      title: 'Move-in Inspection',
      sections: [
        generalInfoSection(),
        keysSection(),
        metersSection(),
        roomConditionSection('entryway', 'Entryway / Hall'),
        roomConditionSection('living_room', 'Living Room'),
        kitchenSection(),
        bathroomSection('bathroom_main', 'Main Bathroom'),
        roomConditionSection('bedroom_1', 'Bedroom 1'),
        roomConditionSection('bedroom_2', 'Bedroom 2 (if present)'),
        appliancesSection(),
        damagesSection(),
        finalNotesSection(),
      ],
    };
  }

  function moveOutSchema() {
    return {
      schemaVersion: 1,
      inspectionType: 'move_out',
      title: 'Move-out Inspection',
      sections: [
        generalInfoSection(),
        keysSection(),
        metersSection(),
        roomConditionSection('entryway', 'Entryway / Hall'),
        roomConditionSection('living_room', 'Living Room'),
        kitchenSection(),
        bathroomSection('bathroom_main', 'Main Bathroom'),
        roomConditionSection('bedroom_1', 'Bedroom 1'),
        roomConditionSection('bedroom_2', 'Bedroom 2 (if present)'),
        appliancesSection(),
        {
          id: 'cleaning',
          title: 'Cleaning',
          items: [
            { id: 'cleaning_state', type: 'select', label: 'Overall cleanliness', required: true,
              options: [
                { value: 'professional', label: 'Professionally cleaned' },
                { value: 'good', label: 'Good' },
                { value: 'acceptable', label: 'Acceptable' },
                { value: 'inadequate', label: 'Inadequate' },
              ], attachments: { enabled: true, max: 5 } },
            { id: 'cleaning_areas_inadequate', type: 'textarea', label: 'Areas requiring re-cleaning',
              visibleWhen: { field: 'cleaning_state', operator: 'equals', value: 'inadequate' },
              requiredWhen: { field: 'cleaning_state', operator: 'equals', value: 'inadequate' } },
          ],
        },
        damagesSection(),
        {
          id: 'deposit',
          title: 'Deposit Settlement',
          items: [
            { id: 'deposit_original', type: 'number', label: 'Original deposit amount' },
            { id: 'deposit_deductions', type: 'number', label: 'Total deductions' },
            { id: 'deposit_returned', type: 'number', label: 'Amount to be returned' },
            { id: 'deposit_explanation', type: 'textarea', label: 'Explanation of deductions',
              visibleWhen: { field: 'deposit_deductions', operator: 'truthy' } },
          ],
        },
        finalNotesSection(),
      ],
    };
  }

  function periodicSchema() {
    return {
      schemaVersion: 1,
      inspectionType: 'periodic',
      title: 'Periodic Inspection',
      sections: [
        generalInfoSection(),
        roomConditionSection('living_room', 'Living Room'),
        kitchenSection(),
        bathroomSection('bathroom_main', 'Main Bathroom'),
        roomConditionSection('bedroom_1', 'Bedroom 1'),
        appliancesSection(),
        {
          id: 'maintenance',
          title: 'Maintenance Items',
          items: [
            { id: 'maint_smoke_detector', type: 'checkbox', label: 'Smoke detectors tested and working' },
            { id: 'maint_filters_changed', type: 'checkbox', label: 'A/C filters checked' },
            { id: 'maint_drains', type: 'checkbox', label: 'Drains running freely' },
            { id: 'maint_pest_signs', type: 'checkbox', label: 'No signs of pest infestation' },
            { id: 'maint_pest_notes', type: 'textarea', label: 'Pest details',
              visibleWhen: { field: 'maint_pest_signs', operator: 'falsy' },
              requiredWhen: { field: 'maint_pest_signs', operator: 'falsy' } },
          ],
        },
        damagesSection(),
        finalNotesSection(),
      ],
    };
  }

  function damageReportSchema() {
    return {
      schemaVersion: 1,
      inspectionType: 'damage_report',
      title: 'Damage Report',
      sections: [
        generalInfoSection(),
        {
          id: 'damage_event',
          title: 'Damage Event Details',
          items: [
            { id: 'damage_event_date', type: 'date', label: 'Date of damage event', required: true },
            { id: 'damage_event_cause', type: 'select', label: 'Cause', required: true,
              options: [
                { value: 'water_leak', label: 'Water leak' },
                { value: 'fire', label: 'Fire' },
                { value: 'storm', label: 'Storm / weather' },
                { value: 'vandalism', label: 'Vandalism' },
                { value: 'tenant_negligence', label: 'Tenant negligence' },
                { value: 'wear', label: 'Wear and tear' },
                { value: 'other', label: 'Other' },
              ] },
            { id: 'damage_event_cause_other', type: 'text', label: 'Specify other cause',
              visibleWhen: { field: 'damage_event_cause', operator: 'equals', value: 'other' },
              requiredWhen: { field: 'damage_event_cause', operator: 'equals', value: 'other' } },
            { id: 'damage_event_description', type: 'textarea', label: 'Detailed description', required: true,
              attachments: { enabled: true, min: 1, max: 15 } },
          ],
        },
        damagesSection(),
        {
          id: 'insurance',
          title: 'Insurance and Resolution',
          items: [
            { id: 'insurance_claim', type: 'checkbox', label: 'Insurance claim filed' },
            { id: 'insurance_claim_number', type: 'text', label: 'Claim number',
              visibleWhen: { field: 'insurance_claim', operator: 'truthy' } },
            { id: 'resolution_plan', type: 'textarea', label: 'Repair / resolution plan' },
            { id: 'resolution_responsible', type: 'select', label: 'Responsible for repair',
              options: [
                { value: 'landlord', label: 'Landlord' },
                { value: 'tenant', label: 'Tenant' },
                { value: 'insurance', label: 'Insurance' },
                { value: 'shared', label: 'Shared' },
              ] },
          ],
        },
        finalNotesSection(),
      ],
    };
  }

  function keyHandoverSchema() {
    return {
      schemaVersion: 1,
      inspectionType: 'key_handover',
      title: 'Key Handover',
      sections: [
        generalInfoSection(),
        keysSection(),
        {
          id: 'access_codes',
          title: 'Access Codes and Credentials',
          items: [
            { id: 'access_alarm_code', type: 'text', label: 'Alarm system code (handover)' },
            { id: 'access_building_code', type: 'text', label: 'Building entry code' },
            { id: 'access_wifi_provided', type: 'checkbox', label: 'Wi-Fi credentials provided' },
            { id: 'access_notes', type: 'textarea', label: 'Other access notes' },
          ],
        },
        finalNotesSection(),
      ],
    };
  }

  function getAllSeeds() {
    return [
      { schemaId: 'schema_move_in_v1',       inspectionType: 'move_in',       version: 1, title: 'Move-in Inspection',     schema: moveInSchema() },
      { schemaId: 'schema_move_out_v1',      inspectionType: 'move_out',      version: 1, title: 'Move-out Inspection',    schema: moveOutSchema() },
      { schemaId: 'schema_periodic_v1',      inspectionType: 'periodic',      version: 1, title: 'Periodic Inspection',    schema: periodicSchema() },
      { schemaId: 'schema_damage_report_v1', inspectionType: 'damage_report', version: 1, title: 'Damage Report',          schema: damageReportSchema() },
      { schemaId: 'schema_key_handover_v1',  inspectionType: 'key_handover',  version: 1, title: 'Key Handover',           schema: keyHandoverSchema() },
    ];
  }

  return { getAllSeeds };
})();
