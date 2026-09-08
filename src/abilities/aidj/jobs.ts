export type { ContinuousTaskState } from './jobs/continuous'
export {
  getContinuousTasks,
  getContinuousTask,
  setContinuousVolbal,
  setContinuousRecordFreq,
  clearContinuousMemory,
  getContinuousVolume,
  setContinuousVolume,
  setContinuousBaseVol,
  boundContinuousPlayer,
  switchContinuousPlayer,
  enqueueContinuousSongs,
  reorderContinuousQueue,
  clearContinuousPending,
  replaceContinuousQueue
} from './jobs/continuous'

export type { ChatTaskState } from './jobs/chat'
export { getChatTask, getChatTasks, setChatPlayer, chatResendPlaylist } from './jobs/chat'

import './jobs/persistent'
import './jobs/continuous'
import './jobs/chat'
import './jobs/misc'
import './jobs/bili-import'
import './jobs/bili-batch'
