window.__ModuleLoader__.load({
  id: 'dsh-wechat-pad',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const API = '/wechat-pad/api/'

    const CARD = {
      border: '1px solid var(--dsh-border, rgba(127,127,127,.28))',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 14,
      background: 'var(--dsh-surface, transparent)',
    }
    const LABEL = { fontSize: 12.5, opacity: 0.7, marginBottom: 4 }
    const INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 9px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }
    const BUTTON = {
      padding: '7px 14px',
      borderRadius: 8,
      border: '1px solid var(--dsh-border, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    }
    const BUTTON_PRIMARY = { ...BUTTON, background: 'var(--dsh-accent, #10a37f)', borderColor: 'var(--dsh-accent, #10a37f)', color: '#fff' }
    const MUTED = { fontSize: 12.5, opacity: 0.65 }
    const ROW = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px dashed var(--dsh-border, rgba(127,127,127,.2))' }

    async function call(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: text.slice(0, 200) }
      }
    }

    function Field({ item, value, onChange }) {
      if (item.type === 'boolean') {
        return h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: Boolean(value),
            onChange: (event) => onChange(item.key, event.target.checked),
          }),
          h('span', null, item.label),
        )
      }
      if (item.type === 'enum') {
        return h('div', null,
          h('div', { style: LABEL }, item.label),
          h('select', {
            value: value ?? item.default,
            style: INPUT,
            onChange: (event) => onChange(item.key, event.target.value),
          }, (item.options || []).map((option) =>
            h('option', { key: option.value, value: option.value }, option.label))),
        )
      }
      if (item.type === 'number') {
        return h('div', null,
          h('div', { style: LABEL }, item.label),
          h('input', {
            type: 'number',
            value: value ?? item.default,
            min: item.min,
            max: item.max,
            step: item.step || 1,
            style: INPUT,
            onChange: (event) => onChange(item.key, Number(event.target.value)),
          }),
        )
      }
      if (item.multiline) {
        return h('div', null,
          h('div', { style: LABEL }, item.label),
          h('textarea', {
            value: value ?? item.default,
            rows: 3,
            style: { ...INPUT, resize: 'vertical' },
            onChange: (event) => onChange(item.key, event.target.value),
          }),
        )
      }
      return h('div', null,
        h('div', { style: LABEL }, item.label),
        h('input', {
          type: 'text',
          value: value ?? item.default,
          style: INPUT,
          onChange: (event) => onChange(item.key, event.target.value),
        }),
      )
    }

    function WeChatPadSettings() {
      const [schema, setSchema] = useState([])
      const [values, setValues] = useState({})
      const [status, setStatus] = useState(null)
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        const [settings, live] = await Promise.all([call('settings'), call('status').catch(() => null)])
        if (settings && settings.ok) {
          setSchema(settings.schema || [])
          setValues(settings.settings || {})
        }
        if (live && live.ok !== false) setStatus(live)
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const setField = useCallback((key, value) => {
        setValues((prev) => ({ ...prev, [key]: value }))
      }, [])

      const save = useCallback(async () => {
        setBusy(true)
        setMessage('保存中…')
        try {
          const result = await call('settings', {
            method: 'POST',
            body: JSON.stringify({ settings: values }),
          })
          setMessage(result.ok ? '已保存，下一条消息生效' : '保存失败：' + (result.error || '未知错误'))
          if (result.ok) await load()
        } finally {
          setBusy(false)
        }
      }, [values, load])

      const runScan = useCallback(async () => {
        setBusy(true)
        try {
          const result = await call('scan', { method: 'POST', body: '{}' })
          setMessage(result.ok ? '已让钩子扫了一次' : '扫描失败：' + (result.error || '未知错误'))
        } finally {
          setBusy(false)
        }
      }, [])

      const resetSessions = useCallback(async () => {
        setBusy(true)
        try {
          const result = await call('sessions/reset', { method: 'POST', body: '{}' })
          setMessage(result.ok ? `已重开 ${result.dropped ?? 0} 个会话` : '重开失败')
        } finally {
          setBusy(false)
        }
      }, [])

      const grouped = useMemo(() => schema, [schema])
      if (schema.length === 0) {
        return h('div', { style: CARD }, h('div', { style: MUTED }, '正在读取微信插件设置…'))
      }

      const stats = status?.stats || {}
      return h('div', null,
        h('div', { style: CARD },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, marginBottom: 6 } }, '微信 · 回话逻辑'),
          h('div', { style: MUTED }, '改完点保存，下一条消息就按新规则走。协议端地址和密钥不在这里改。'),
          h('div', { style: { height: 10 } }),
          grouped.map((item) => h('div', { key: item.key, style: ROW },
            h('div', { style: { flex: 1 } }, h(Field, { item, value: values[item.key], onChange: setField })),
            item.hint ? h('div', { style: { ...MUTED, width: 220 } }, item.hint) : null,
          )),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' } },
            h('button', { style: BUTTON_PRIMARY, disabled: busy, onClick: save }, '保存设置'),
            h('button', { style: BUTTON, disabled: busy, onClick: runScan }, '立即扫描一次'),
            h('button', { style: BUTTON, disabled: busy, onClick: resetSessions }, '重开会话'),
            h('button', { style: BUTTON, onClick: load }, '刷新'),
            h('a', {
              href: '/wechat-pad',
              target: '_blank',
              rel: 'noreferrer',
              style: { ...BUTTON, textDecoration: 'none', lineHeight: '1.4' },
            }, '打开完整面板'),
          ),
          message ? h('div', { style: { ...MUTED, marginTop: 8 } }, message) : null,
        ),
        h('div', { style: CARD },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, marginBottom: 6 } }, '运行状态'),
          h('div', { style: MUTED },
            '协议端 ' + (status?.padUrl || '未配置')
            + ' · 探活 ' + (status?.probe?.ok ? '正常' : (status?.probe?.error || '未知'))
            + ' · 已回复 ' + (stats.replied || 0)
            + ' · 跳过（没 @）' + (stats['skip:not-mentioned'] || 0)
            + ' · 错误 ' + (stats.errors || 0)),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'wechat-pad', order: 17, label: () => '微信' },
            WeChatPadSettings,
          ),
        )
      },
    }
  },
})
