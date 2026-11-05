import type { HarnessLimits, LimitWindow } from '@shared/contract'
import { tr } from '../lib/i18n'

const LABEL: Record<LimitWindow['kind'], string> = { five_hour: '5ч', weekly: 'нед' }
const NAME: Record<LimitWindow['kind'], string> = { five_hour: 'Лимит на 5 часов', weekly: 'Лимит на неделю' }

function untilReset(at: number, now: number): string {
  const min = Math.max(1, Math.round((at - now) / 60000))
  if (min < 60) return tr('{0}м', min)
  const h = Math.floor(min / 60)
  if (h < 24) return tr('{0}ч {1}м', h, min % 60)
  return tr('{0}д {1}ч', Math.floor(h / 24), h % 24)
}

/** Green is what is left, grey is what is used. A window whose reset time has passed counts as full again. */
export function LimitBars({ limits, onSignIn }: { limits: HarnessLimits; onSignIn: () => void }): JSX.Element | null {
  if (limits.status === 'none') return null
  if (limits.status === 'signin') {
    return (
      <button
        type="button"
        className="limit-signin"
        title={tr('Войти в Claude, чтобы видеть лимиты')}
        onClick={(e) => {
          e.stopPropagation()
          onSignIn()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {tr('войти')}
      </button>
    )
  }
  if (limits.status === 'error') {
    return (
      <span className="limit-none" title={limits.note}>
        {tr('нет данных')}
      </span>
    )
  }
  const now = Date.now()
  return (
    <span className="limits">
      {limits.windows.map((w) => {
        const left = w.resetsAt !== null && w.resetsAt <= now ? 100 : Math.round(100 - w.usedPercent)
        const reset = w.resetsAt !== null && w.resetsAt > now ? untilReset(w.resetsAt, now) : null
        return (
          <span key={w.kind} className="limit" title={tr('{0}: осталось {1}%{2}', tr(NAME[w.kind]), left, reset ? tr(', обновится через {0}', reset) : '')}>
            <span className="limit-label">{tr(LABEL[w.kind])}</span>
            <span className="limit-bar" role="img" aria-label={tr('{0}: осталось {1}%', tr(NAME[w.kind]), left)}>
              <span className="limit-fill" style={{ width: `${left}%` }} />
            </span>
            <span className="limit-pct">{left}%</span>
            {reset && <span className="limit-reset">{tr('через {0}', reset)}</span>}
          </span>
        )
      })}
    </span>
  )
}
