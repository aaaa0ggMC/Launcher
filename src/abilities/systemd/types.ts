// Systemd ability domain types.

export interface SystemdUnit {
  name: string
  description: string
  active: string
  sub: string
  loaded: boolean
}
