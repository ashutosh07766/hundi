import { AgentIcon, ShieldCheckIcon, SignatureIcon } from './icons.js'

const STEPS = [
  {
    icon: SignatureIcon,
    title: 'Sign a spending mandate',
    body: 'You set the rules — a ceiling, an approval threshold, and which merchants are in scope.',
  },
  {
    icon: AgentIcon,
    title: 'An agent shops within it',
    body: 'A separate AI agent key builds carts and checks out, but can never approve or revoke.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Every payment is verified first',
    body: 'The facilitator checks each cart against the mandate before money moves — no exceptions.',
  },
] as const

export function HowItWorks() {
  return (
    <ol className="how-it-works" aria-label="How Hundi works">
      {STEPS.map((step, i) => (
        <li className="how-it-works__step" key={step.title}>
          <span className="how-it-works__index">{i + 1}</span>
          <step.icon className="how-it-works__icon" />
          <div>
            <p className="how-it-works__title">{step.title}</p>
            <p className="how-it-works__body">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
