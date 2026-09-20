import { describe, expect, it } from 'vitest'
import { parseAgentExtras } from './computerAgentExtras'

describe('parseAgentExtras', () => {
  it('returns null for empty extended', () => {
    expect(parseAgentExtras(null)).toBeNull()
    expect(parseAgentExtras({})).toBeNull()
  })

  it('parses full-audit fields used on the PC card', () => {
    const extras = parseAgentExtras({
      system: { primary_user: 'EKM\\ivanov' },
      network: { gateways: ['192.168.1.1'], dns_v4: ['8.8.8.8'], wifi: [{ ssid: 'Office' }] },
      physical_disks: [
        {
          friendly_name: 'Samsung SSD',
          media_type: 'SSD',
          health_status: 'Healthy',
          size_gb: 476.9,
          temperature_c: 38,
          wear_percent: 4,
          power_on_hours: 12000,
        },
      ],
      tpm: { present: true },
      secure_boot_enabled: true,
      pending_reboot: true,
      antivirus: [{ display_name: 'Windows Defender' }],
      gpus: [{ name: 'RTX', vram_gb: 8, driver_version: '32.0' }],
      local_admins: ['Administrator', 'EKM\\helpdesk'],
      battery_health: { health_percent: 87, charge_remaining_percent: 55 },
      last_hotfix_id: 'KB5034441',
      uptime_hours: 42.5,
      timezone: 'Russian Standard Time',
      monitors: [{ manufacturer: 'DEL', model: 'U2720Q', year: 2021 }],
      ram_modules: [{ slot: 'DIMM1', size_gb: 16, speed_mhz: 3200 }],
      firewall: { domain: true, private: true, public: false },
      defender: { rtp_enabled: true, signature_age_days: 1 },
      listening_ports_count: 17,
      scheduled_tasks_count: 4,
      hard_errors: [{ id: 41 }],
      expiring_certs: [{ subject: 'CN=pc.local', days_left: 12 }],
      screen_resolution: '2560x1440@60Hz',
      activation: 'Licensed',
      rdp_enabled: true,
      smb1_enabled: true,
      uac_enabled: false,
      problem_devices: [{ name: 'Unknown USB' }],
      local_users_enabled: 3,
      shares: [{ name: 'share' }],
      logged_on_users: ['ivanov'],
      usb_storage_history_count: 5,
      patches: [{ hotfix_id: 'KB1' }, { hotfix_id: 'KB2' }],
    })

    expect(extras).not.toBeNull()
    expect(extras?.primaryUser).toBe('EKM\\ivanov')
    expect(extras?.gateways).toEqual(['192.168.1.1'])
    expect(extras?.dnsV4).toEqual(['8.8.8.8'])
    expect(extras?.wifiSsid).toBe('Office')
    expect(extras?.physicalDisks[0]).toMatchObject({
      name: 'Samsung SSD',
      temperatureC: 38,
      wearPercent: 4,
      powerOnHours: 12000,
    })
    expect(extras?.securityHint).toContain('TPM')
    expect(extras?.securityHint).toContain('Secure Boot')
    expect(extras?.securityHint).toContain('Pending reboot')
    expect(extras?.gpus[0]).toContain('RTX')
    expect(extras?.localAdmins).toEqual(['Administrator', 'EKM\\helpdesk'])
    expect(extras?.batteryHealthPercent).toBe(87)
    expect(extras?.batteryPercent).toBe(55)
    expect(extras?.lastHotfix).toBe('KB5034441')
    expect(extras?.uptimeHours).toBe(42.5)
    expect(extras?.timezone).toBe('Russian Standard Time')
    expect(extras?.monitors[0]).toContain('U2720Q')
    expect(extras?.ramModules[0]).toContain('16 GB')
    expect(extras?.firewall).toBe('domain/private on')
    expect(extras?.defenderHint).toContain('RTP')
    expect(extras?.listeningPortsCount).toBe(17)
    expect(extras?.scheduledTasksCount).toBe(4)
    expect(extras?.hardErrorsCount).toBe(1)
    expect(extras?.expiringCerts[0]).toEqual({ subject: 'CN=pc.local', daysLeft: 12 })
    expect(extras?.screenResolution).toBe('2560x1440@60Hz')
    expect(extras?.activation).toBe('Licensed')
    expect(extras?.securityPosture).toBe('RDP on · SMB1 on · UAC off')
    expect(extras?.problemDevicesCount).toBe(1)
    expect(extras?.localUsersEnabled).toBe(3)
    expect(extras?.sharesCount).toBe(1)
    expect(extras?.loggedOnUsers).toEqual(['ivanov'])
    expect(extras?.usbHistoryCount).toBe(5)
    expect(extras?.patchTotal).toBe(2)
  })
})
