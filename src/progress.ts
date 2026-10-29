import type { AgentManager } from './agent.js';
import type { ProviderProgress } from './types.js';

type View = ReturnType<AgentManager['get']>;
const seconds = (ms: number) => Math.floor(Math.max(0, ms) / 1000);
const stages: Record<ProviderProgress['stage'], string> = {
  starting: '启动 agy', submitted: '请求已提交，等待 agy 初始化', initialized: 'agy 会话已建立',
  activity: 'Gemini 正在执行', waiting: '等待 agy 新事件', retrying: 'agy 遇到服务错误，正在自行重试', completed: '本轮生成完成', failed: '本轮生成失败'
};
const steps = { user_input: '接收任务', agent_response: '生成响应', checkpoint: '保存检查点', tool: '执行原生工具', subagent: '执行原生子代理' };

/** Operational facts only. Never interpolate model text, arguments, paths or reasoning. */
export function providerMessage(progress: ProviderProgress): string {
  const step = progress.stepType ? steps[progress.stepType] : undefined;
  const state = progress.stepState === 'DONE' ? '完成' : '进行中';
  const reason = progress.errorCode === 'PROVIDER_UNAVAILABLE' ? '服务容量暂不可用' : progress.errorCode === 'AGY_NETWORK_ERROR' ? '连接中断' : progress.errorCode === 'PROVIDER_RATE_LIMITED' ? '服务限流' : undefined;
  const limit = progress.timeoutMs > 0 ? `，时限 ${seconds(progress.timeoutMs)} 秒` : '，未设置执行时限';
  return `${stages[progress.stage]}${progress.stage === 'retrying' && reason ? `：${reason}` : ''}${step && progress.stage === 'activity' ? `：${step}${state}` : ''}；已用 ${seconds(progress.elapsedMs)} 秒，距上次活动 ${seconds(progress.silentMs ?? 0)} 秒${limit}`;
}

export function progressSummary(view: Pick<View, 'status' | 'runtime' | 'error'>) {
  const runtime = view.runtime;
  const message = view.status === 'queued' ? '任务已排队，等待前序任务释放 Provider' :
    view.status === 'waiting' ? '任务等待补充信息' :
    view.status === 'completed' ? '任务完成，等待调用方验收' :
    view.status === 'cancelled' ? '已请求中断任务' :
    view.status === 'failed' ? `任务失败：${view.error?.code ?? 'UNKNOWN'}` :
    runtime ? providerMessage({ ...runtime, time: runtime.lastActivityAt, sessionReused: runtime.sessionReused ?? false,
      stepType: runtime.lastStepType, stepState: runtime.lastStepState }) : '任务正在准备执行';
  return { message, status: view.status, stage: runtime?.stage, elapsedMs: runtime?.elapsedMs ?? 0,
    silentMs: runtime?.silentMs ?? 0, timeoutMs: runtime?.timeoutMs, stepUpdates: runtime?.stepUpdates ?? 0,
    lastStepType: runtime?.lastStepType, lastStepState: runtime?.lastStepState,
    processPid: runtime?.pid, errorCode: view.error?.code };
}

/** Full status remains available; polling can request bounded, cursor-based updates. */
export function presentAgent(view: View, compact = false, afterRevision?: number) {
  const summary = progressSummary(view);
  if (!compact) return { ...view, progress: summary };
  const fresh = view.events.filter(event => afterRevision === undefined || ('revision' in event && Number(event.revision) > afterRevision));
  const events = fresh.slice(-64);
  // Parent instructions and the final report are already returned at their own boundaries.
  const messages = view.messages.filter(message => message.from === 'gemini' &&
    (afterRevision === undefined || fresh.some(event => event.type === 'message' && event.detail === `gemini: ${message.text}`))).slice(-8);
  return { id: view.id, task_name: view.task_name, status: view.status, executionMode: view.executionMode,
    deduplicated: view.deduplicated, recovery: view.recovery, partial: view.partial,
    revision: view.revision, runs: view.runs, runtime: view.runtime, progress: summary,
    events, eventsTruncated: fresh.length > events.length || (view.events.length === 512 && afterRevision !== undefined &&
      view.events.length > 0 && 'revision' in view.events[0] && Number(view.events[0].revision) > afterRevision + 1),
    messages, changedFiles: view.changedFiles, commands: view.commands,
    providerCallCount: view.providerCalls.length, browserCheckCount: view.browserChecks.length,
    waiting: view.waiting, result: view.result, error: view.error };
}
