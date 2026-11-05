import { X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ')

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-white hover:brightness-110 disabled:opacity-50',
    secondary: 'bg-elev text-fg border border-line hover:bg-hover disabled:opacity-50',
    ghost: 'text-muted hover:text-fg hover:bg-hover disabled:opacity-40',
    danger: 'bg-err/10 text-err border border-err/30 hover:bg-err/20 disabled:opacity-50'
  }
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        variants[variant],
        className
      )}
    />
  )
}

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('rounded-lg border border-line bg-panel', className)}>
      {children}
    </div>
  )
}

export function CardHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-10 items-center justify-between border-b border-line px-4">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {action}
    </div>
  )
}

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info'
const TONES: Record<Tone, string> = {
  neutral: 'bg-elev text-muted border-line',
  accent: 'bg-accent-soft text-[#b4aaff] border-accent/30',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  err: 'bg-err/10 text-err border-err/30',
  info: 'bg-info/10 text-info border-info/30'
}

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4 font-medium', TONES[tone])}>
      {children}
    </span>
  )
}

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-elev', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-[13px] font-medium text-fg">{title}</div>
      {children && <div className="max-w-sm text-xs leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  tone
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  tone?: 'err' | 'ok'
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-muted">
        <span className="text-xs font-medium">{label}</span>
        {icon}
      </div>
      <div className={cx('mt-2 text-2xl leading-none font-semibold tabular-nums', tone === 'err' && 'text-err', tone === 'ok' && 'text-ok')}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-faint">{sub}</div>}
    </Card>
  )
}

const FIELD = 'rounded-md border border-line bg-bg px-2.5 text-[13px] text-fg placeholder:text-faint focus:border-accent focus:outline-none'

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  )
}
/** Fields fill their container unless the caller sets its own width (a w-* class), which Tailwind would otherwise lose to w-full. */
const fullWidth = (className?: string): string => (/(^|\s)w-/.test(className ?? '') ? '' : 'w-full')
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(FIELD, fullWidth(p.className), 'h-8', p.className)} />
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(FIELD, fullWidth(p.className), 'h-8', p.className)} />
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(FIELD, fullWidth(p.className), 'resize-none py-1.5', p.className)} />

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="page-enter flex max-h-[80vh] w-[560px] max-w-[92vw] flex-col rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}
