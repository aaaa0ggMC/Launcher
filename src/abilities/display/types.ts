// Display ability domain types (wallpapers / outputs).

export interface WallpaperFile {
  name: string
  path: string
}

export interface DisplayOutput {
  name: string
  description: string
  connected: boolean
  enabled: boolean
}
