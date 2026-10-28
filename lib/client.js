/**
 * dsh-relay 客户端半区 —— 「接力」开关
 *
 * 完全照抄 dsh-client-auto-continue 的实现：
 *   - 插槽：conversation.input.left（输入框左侧按钮区）
 *   - 控件：@deepseek-ai/dsh-client-ui-primitives 的 Switch（原生开关，有动画）
 *   - 样式类：沿用 dshAcComposer / dshAcComposerLabel 的观感
 *   - 格式：window.__ModuleLoader__.load({id, factory})
 */
window.__ModuleLoader__.load({
  id: 'dsh-relay',

  factory: (require) => {
    const module = { exports: {} };

    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    // 原生开关（与 auto-continue / 设置页同一个组件）
    let NativeSwitch = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      const Switch = primitives && primitives.Switch;
      if (typeof Switch === 'function') NativeSwitch = Switch;
    } catch (e) {
      /* 降级到原生 checkbox */
    }

    const SLOT = 'conversation.input.left';
    const ID = 'dsh-relay';
    const API = '/dsh-relay';

    function sessionIdOf(props) {
      return (
        (props && props.sessionId) ||
        (props && props.session && props.session.id) ||
        (props && props.scope && (props.scope.sessionId || (props.scope.session && props.scope.session.id))) ||
        ''
      );
    }

    /** 接力开关 */
    function RelayComposerToggle(props) {
      const sid = sessionIdOf(props);
      const [mode, setMode] = React.useState('off'); // 默认关闭
      const [reason, setReason] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      React.useEffect(() => {
        if (!sid) return undefined;
        let alive = true;
        fetch(API + '/mode?sessionId=' + encodeURIComponent(sid))
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!alive || !d) return;
            setMode(d.mode || 'off');
            setReason(d.reason || '');
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [sid]);

      const setEnabled = React.useCallback(
        (nextOn) => {
          if (!sid || busy) return;
          setBusy(true);
          setFailed(false);
          fetch(API + '/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: sid,
              mode: nextOn ? 'on' : 'off',
              reason: 'ui-toggle',
            }),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((d) => {
              setMode(d.mode || (nextOn ? 'on' : 'off'));
              setReason(d.reason || '');
            })
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        },
        [sid, busy],
      );

      if (!sid) return null;

      const enabled = mode === 'on';
      const title = failed
        ? '保存失败，请重试'
        : enabled
          ? '上下文满时自动总结并开新会话继续（点击关闭，改用原生压缩）'
          : '本会话不接力，走 DSH 原生压缩（点击开启接力）';

      const switchEl = NativeSwitch
        ? jsx(NativeSwitch, {
            checked: enabled,
            onChange: setEnabled,
            disabled: busy,
            label: '会话接力',
            title,
          })
        : jsx('input', {
            type: 'checkbox',
            checked: enabled,
            disabled: busy,
            onChange: (e) => setEnabled(e.target.checked),
            title,
            style: { cursor: busy ? 'wait' : 'pointer' },
          });

      return jsxs('div', {
        className: 'dshAcComposer',
        title,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginRight: 8,
          userSelect: 'none',
        },
        children: [
          jsx('span', {
            className: 'dshAcComposerLabel',
            style: { fontSize: 12, opacity: 0.85, whiteSpace: 'nowrap' },
            children: '接力',
          }),
          jsx('span', {
            className: 'dshAcSwitchTarget',
            style: { display: 'inline-flex', alignItems: 'center' },
            children: switchEl,
          }),
          jsx('span', {
            className: 'dshAcComposerError',
            role: 'status',
            style: { fontSize: 11, color: '#e5534b' },
            children: failed ? '保存失败' : null,
          }),
        ],
      });
    }

    module.exports.inject = ['slots'];

    module.exports.apply = function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.warn('[dsh-relay] slots 服务不可用');
        return;
      }
      try {
        slots.inject(SLOT, () => {
          try {
            return slots.register(
              {
                name: SLOT,
                id: ID,
                inject: (slotProps) => Object.assign({}, slotProps),
              },
              RelayComposerToggle,
            );
          } catch (e) {
            console.warn('[dsh-relay] register 失败', e);
            return undefined;
          }
        });
      } catch (e) {
        console.warn('[dsh-relay] 插槽注册失败', e);
      }
    };

    return module.exports;
  },
});
