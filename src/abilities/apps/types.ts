// Apps ability domain types — the app registry + launch model.
//
// The app-entry contract is consumed by the framework shell (search
// quick-launch, entry-action framework, transformer modal), so the shapes live
// in `src/shared/types.ts` and are re-exported here. The ability-specific
// registry/launcher internals (SearchRoot etc.) stay in this folder.

export type {
  ExecType,
  AppExecSpec,
  AppSecurity,
  RiskLevel,
  AppAction,
  AppEntry,
  AppRegistryFile
} from '../../shared/types'
