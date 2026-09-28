// helixus-live: 弹幕点图 / 看屏幕 reaction 的设置（挂在「游戏实况」设置页底部）
import {
  DEFAULT_HELIXUS_LIVE,
  helixusLiveSettings,
  HelixusLiveSettings,
} from '@/features/helixus/liveSettings'
import { clearGameMemory, gameMemoryStore } from '@/features/helixus/gameMemory'
import { mcStore } from '@/features/helixus/minecraft'
import { setSelfPlayMode } from '@/components/helixusLive'

type NumKey = {
  [K in keyof HelixusLiveSettings]: HelixusLiveSettings[K] extends number
    ? K
    : never
}[keyof HelixusLiveSettings]
type ObjKey = 'drawFrameRect' | 'drawCharLayout' | 'reactionCharLayout'

const input =
  'w-24 rounded-lg bg-white px-2 py-1 text-sm hover:bg-white-hover disabled:opacity-50'

function Num({ k, label }: { k: NumKey; label: string }) {
  const v = helixusLiveSettings((s) => s[k])
  return (
    <label className="flex items-center gap-2 my-1 text-sm">
      <span className="w-56">{label}</span>
      <input
        type="number"
        className={input}
        value={v}
        step="any"
        onChange={(e) =>
          helixusLiveSettings.setState({
            [k]: parseFloat(e.target.value) || 0,
          } as Partial<HelixusLiveSettings>)
        }
      />
    </label>
  )
}

function Obj({ k, label }: { k: ObjKey; label: string }) {
  const v = helixusLiveSettings((s) => s[k]) as Record<string, number>
  return (
    <div className="my-2 text-sm">
      <div className="mb-1">{label}</div>
      <div className="flex flex-wrap gap-3">
        {Object.keys(v).map((f) => (
          <label key={f} className="flex items-center gap-1">
            <span>{f}</span>
            <input
              type="number"
              step="any"
              className={input}
              value={v[f]}
              onChange={(e) =>
                helixusLiveSettings.setState({
                  [k]: { ...v, [f]: parseFloat(e.target.value) || 0 },
                } as Partial<HelixusLiveSettings>)
              }
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function Text({
  k,
  label,
  area,
}: {
  k:
    | 'drawServiceUrl'
    | 'drawPrefixes'
    | 'ttsBlockWords'
    | 'mcLinkUrl'
    | 'selfPlayHotkey'
  label: string
  area?: boolean
}) {
  const v = helixusLiveSettings((s) => s[k])
  const set = (x: string) =>
    helixusLiveSettings.setState({ [k]: x } as Partial<HelixusLiveSettings>)
  return (
    <label className="block my-2 text-sm">
      <div className="mb-1">{label}</div>
      {area ? (
        <textarea
          className="w-full h-20 rounded-lg bg-white px-2 py-1"
          value={v}
          onChange={(e) => set(e.target.value)}
        />
      ) : (
        <input
          className="w-full rounded-lg bg-white px-2 py-1"
          value={v}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </label>
  )
}

function McLinkStatus() {
  const selfPlay = mcStore((s) => s.selfPlay)
  const reachable = mcStore((s) => s.reachable)
  const online = mcStore((s) => s.status?.online ?? false)
  const civ = mcStore((s) => s.status?.game === 'civ6')
  const text = !selfPlay
    ? '模式没开（开了才会连游戏代理）'
    : !reachable
      ? '游戏代理连不上：先双击 start_minecraft_bot.bat 或 start_civ_player.bat'
      : civ
        ? online
          ? '文明6：已连上对局'
          : '文明6 代理开着，但游戏没开或还没进对局'
        : online
          ? 'Minecraft：已连上，角色在游戏里'
          : 'Minecraft bot 开着，但角色不在游戏里（游戏 / 局域网没开）'
  return (
    <div className="my-2 flex items-center gap-3 text-sm">
      <div className="rounded-lg bg-white/60 p-2">当前：{text}</div>
      {/* 快捷键被别的程序抢走时，用这个按钮开关 */}
      <button
        className="rounded-lg bg-secondary px-3 py-1 text-theme hover:bg-secondary-hover"
        onClick={() => setSelfPlayMode(!selfPlay)}
      >
        {selfPlay ? '停止自己玩' : '开始自己玩'}
      </button>
    </div>
  )
}

export default function HelixusLiveSettingsPanel() {
  const game = gameMemoryStore((s) => s.game)
  const conf = gameMemoryStore((s) => s.confidence)
  const summary = gameMemoryStore((s) => s.summary)
  return (
    <div className="my-6">
      <div className="my-4 text-xl font-bold">Helixus 直播：点图 / 看屏幕</div>
      <div className="my-2 text-sm whitespace-pre-wrap">
        快捷键：Ctrl+Alt+P 点图模式，Ctrl+Alt+G 看屏幕
        reaction（两者互斥），Ctrl+Alt+I 重新识别游戏，Ctrl+Alt+K
        自己玩游戏（reaction + 操控本机的游戏代理；字母可在下面改，M
        也认）。快捷键没反应时用下面的「开始自己玩」按钮。{'\n'}
        布局数值：画框是视口百分比；角色先以画面右下角为原点按 scale
        缩放，再平移 x（vw）、y（vh），负数往左 / 往上。
      </div>

      <div className="my-4 font-bold">点图</div>
      <Text k="drawServiceUrl" label="画图服务地址（forge_service）" />
      <Text
        k="drawPrefixes"
        label="指令前缀（逗号分隔；不带 / 的前缀后面要跟空格、冒号或量词，如「画 猫」「画一只猫」）"
      />
      <Num k="drawUserCooldownSec" label="同一用户冷却（秒）" />
      <Num k="drawQueueMax" label="全局排队上限" />
      <Num k="drawMaxChars" label="需求最长字数" />
      <Num k="drawShowSec" label="图片展示多久回到空闲（秒）" />
      <Obj k="drawFrameRect" label="画框区域（视口 %）" />
      <Obj k="drawCharLayout" label="点图模式角色布局" />

      <div className="my-4 font-bold">看屏幕 reaction</div>
      <Obj k="reactionCharLayout" label="reaction 模式角色布局" />
      <Num k="gameReidentifyMin" label="每隔几分钟重新识别游戏（0=不定时）" />
      <Num k="gameSummaryEvery" label="每几轮实况压缩一次「本场经过」" />
      <Num k="gameConfidenceMin" label="识别把握低于多少算「未确定」" />
      <div className="my-2 text-sm whitespace-pre-wrap rounded-lg bg-white/60 p-2">
        当前游戏：{game ? `${game}（把握 ${conf.toFixed(2)}）` : '未识别'}
        {'\n'}本场经过：{summary || '（还没有）'}
      </div>
      <button
        className="my-1 rounded-lg bg-secondary px-3 py-1 text-sm text-theme hover:bg-secondary-hover"
        onClick={clearGameMemory}
      >
        清空游戏记忆
      </button>

      <div className="my-4 font-bold">自己玩游戏（Minecraft / 文明6）</div>
      <Text
        k="mcLinkUrl"
        label="游戏代理接口地址（Minecraft bot 或文明6 代理，都在 8098，同一时间只开一个）"
      />
      <Num
        k="mcPokeCooldownSec"
        label="游戏里出事提前开口的最短间隔（秒，死亡 / 濒死不受限）"
      />
      <Text
        k="selfPlayHotkey"
        label="快捷键字母（Ctrl+Alt+这个字母；被别的程序占用就换一个）"
      />
      <McLinkStatus />

      <div className="my-4 font-bold">TTS 前敏感词兜底</div>
      <Text
        k="ttsBlockWords"
        label="命中的词在念出来之前换成「哔」（逗号或换行分隔）"
        area
      />

      <button
        className="my-2 rounded-lg bg-secondary px-3 py-1 text-sm text-theme hover:bg-secondary-hover"
        onClick={() =>
          helixusLiveSettings.setState({ ...DEFAULT_HELIXUS_LIVE })
        }
      >
        恢复这一节的默认值
      </button>
    </div>
  )
}
