/**
 * Claude Auto-Resume — Fetch Interceptor
 * Runs in MAIN world (page context) to intercept Claude.ai's internal fetch calls.
 * Captures the exact API URL, org/conv IDs, and message payload so the server
 * can replay them with "continue" when the cooldown ends.
 */
(function () {
  'use strict';

  const _fetch      = window.fetch.bind(window);
  const ORG_RE      = /\/organizations\/([a-f0-9-]{36})/;
  const CONV_RE     = /\/chat_conversations\/([a-f0-9-]{36})/;
  const TRIGGER_RE  = /\/completion$/;

  window.fetch = async function (input, init) {
    const url = (typeof input === 'string') ? input
              : (input instanceof URL)      ? input.href
              : (input?.url ?? '');

    if (TRIGGER_RE.test(url) && url.includes('/chat_conversations/')) {
      try {
        const orgM  = url.match(ORG_RE);
        const convM = url.match(CONV_RE);

        if (orgM && convM && init?.body) {
          const payload = JSON.parse(init.body);

          window.dispatchEvent(new CustomEvent('__car_capture__', {
            detail: {
              apiUrl:          url,
              orgId:           orgM[1],
              convId:          convM[1],
              parentMsgUuid:   payload.parent_message_uuid ?? null,
              timezone:        payload.timezone             ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
              renderingMode:   payload.rendering_mode       ?? 'raw',
              payloadTemplate: payload,
              ts:              Date.now()
            }
          }));
        }
      } catch (_) { /* never break the page */ }
    }

    return _fetch(input, init);
  };
})();
