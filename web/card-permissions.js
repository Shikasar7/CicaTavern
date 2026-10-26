// 卡片界面权限 (角色卡菜单): what this card's own interface may do without a click
// from the player, as answered when it first asked (web/shared/frame-permissions.js),
// changed here. Each change is kept at once.
import { t } from '/i18n.js'

/**
 * @param deps - { el, permissions (createFramePermissions), onRelayChange(cardId) (frames already open learn the
 *   addresses their card may reach) }
 * @returns { open(card) }
 */
export function initCardPermissions({ el, permissions, onRelayChange }) {
  let dialog = null

  const CHOICES = [
    ['', t`用到时再问`],
    ['allow', t`允许`],
    ['deny', t`不允许`],
  ]
  const choice = (value, label, onPick) => {
    const select = el('select', { 'aria-label': label }, CHOICES.map(([key, text]) => el('option', { value: key, text, selected: key === (value ?? '') })))
    select.addEventListener('change', () => onPick(select.value || null))
    return select
  }

  function open(card) {
    dialog ??= document.body.appendChild(el('dialog', { class: 'dialog card-permissions', 'aria-label': t`卡片界面权限` }))
    const render = () => {
      const kept = permissions.of(card.id)
      const row = (title, hint, control) => el('div', { class: 'cp-row' }, [el('div', { class: 'cp-text' }, [el('span', { class: 'cp-title', text: title }), el('span', { class: 'hint', text: hint })]), control])
      // The select already shows it: nothing to draw again (the focus stays where it is).
      const pick = kind => value => permissions.decide(card.id, kind, value)
      const origins = Object.entries(kept.relay)
      const addresses = origins.length
        ? origins.map(([origin, value]) =>
            row(
              origin,
              kept.local[origin] === 'allow' ? t`也允许过它连接这台电脑或局域网里的服务` : kept.local[origin] === 'deny' ? t`不允许它连接这台电脑或局域网里的服务` : '',
              choice(value, origin, decision => {
                permissions.decide(card.id, 'relay', decision, origin)
                onRelayChange?.(card.id)
                render()
              }),
            ),
          )
        : [el('p', { class: 'hint', text: t`还没有问过要连接哪个地址。` })]
      dialog.replaceChildren(
        el('form', { method: 'dialog', class: 'cp-form' }, [
          el('h2', { text: t`「${card.name}」的卡片界面权限` }),
          el('p', { class: 'hint', text: t`卡片界面（回复里卡片自带的网页界面）第一次要做这些事时会问你一次，之后照你的选择来，不再询问。选「用到时再问」，下次用到时重新问。` }),
          row(t`自己发送输入框里的内容`, t`你没有点它、它自己发出去的时候；每发一次按一轮对话计费。在卡片界面里点它的按钮发送算你自己发的，不用问。`, choice(kept.send, t`自己发送输入框里的内容`, pick('send'))),
          row(t`自己调用模型`, t`比如生成角色信息；每次按一次对话计费，内容不进对话。`, choice(kept.generate, t`自己调用模型`, pick('generate'))),
          el('h3', { text: t`经 CicaTavern 连接的地址` }),
          el('p', { class: 'hint', text: t`卡片界面自己的网络请求，浏览器直接连不上时改由 CicaTavern 替它连接，它发出的内容会经过 CicaTavern。` }),
          ...addresses,
          el('div', { class: 'row end' }, [el('button', { class: 'btn primary', value: 'close', text: t`完成` })]),
        ]),
      )
    }
    render()
    if (!dialog.open) dialog.showModal()
  }

  return { open }
}
