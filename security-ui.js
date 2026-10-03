/* ============================================================
   DRIP COLLECTIVES - Security warning UI layer
   Touchpoint 1: sign-in verification (MFA / unrecognized device)
   Touchpoint 2: checkout security alert
   Touchpoint 3: account deletion confirmation (3s friction)
   Touchpoint 4: file upload type warning
   Plus a demo switch to fall back to native alert()/confirm().

   Depends on: app-state.js  (window.AppState)
   Exposes:    window.DripUI
   ============================================================ */
(function (global, doc) {
  'use strict';

  var AppState = global.AppState;
  if (!AppState) { return; }

  var UNSUPPORTED_FILE_MESSAGE =
    'Warning: File type not supported. For security reasons, only image files (.png, .jpg) are allowed.';

  var ALERT_ICONS = { danger: '!', warn: '!', success: '✓', info: 'i' };
  var SIZE_OPTIONS = ['XS', 'S', 'M', 'L', 'XL'];

  var overlay = null;
  var dialog = null;
  var alertStack = null;
  var modeSwitch = null;
  var modeSwitchInput = null;
  var modeSwitchValue = null;
  var built = false;
var initialized = false;
  var activeConfig = null;
  var lastFocused = null;
  var previousOverflow = '';
  var timers = [];

  /* ---------------------------------------------------------
     tiny helpers
     --------------------------------------------------------- */

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined && text !== null) { node.textContent = text; }
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) { node.removeChild(node.firstChild); }
  }

  function query(selector, root) {
    return (root || doc).querySelector(selector);
  }

  function queryAll(selector, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(selector));
  }

  function peso(value) {
    return AppState.formatPeso(value);
  }

  function parsePrice(text) {
    if (!text) { return null; }
    var match = String(text).match(/(\d[\d\s,.]*)/);
    if (!match) { return null; }
    var raw = match[1].replace(/\s/g, '');
    var parts = raw.split('.');
    var value;
    if (parts.length === 1) {
      value = parseFloat(raw.replace(/,/g, ''));
    } else if (parts[parts.length - 1].length === 2) {
      value = parseFloat(parts.slice(0, -1).join('').replace(/,/g, '') + '.' + parts[parts.length - 1]);
    } else {
      value = parseFloat(raw.replace(/[.,]/g, ''));
    }
    return isNaN(value) ? null : value;
  }

  function fileAcceptList() {
    return AppState.ALLOWED_EXTENSIONS.join(',');
  }

  var boundUploads = [];

  /* In native-popup mode the accept filter is removed on purpose so testers
     can actually pick a .exe / .js file and trigger the native alert(). */
  function syncUploadAccept() {
    var accept = AppState.isNativeMode() ? '' : fileAcceptList();
    boundUploads.forEach(function (input) {
      if (accept) {
        input.setAttribute('accept', accept);
      } else {
        input.removeAttribute('accept');
      }
    });
  }

  function registerTimer(id) {
    timers.push(id);
    return id;
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) {
      global.clearInterval(timers[i]);
      global.clearTimeout(timers[i]);
    }
    timers = [];
  }

  /* ---------------------------------------------------------
     shell: overlay + dialog + alert stack + mode switch
     --------------------------------------------------------- */

  function buildShell() {
    if (built) { return; }

    overlay = el('div', 'dc-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    dialog = el('div', 'dc-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');
    overlay.appendChild(dialog);
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay && activeConfig && activeConfig.dismissible !== false) {
        closeModal();
      }
    });
    doc.body.appendChild(overlay);

    alertStack = el('div', 'dc-alert-stack');
    alertStack.setAttribute('aria-live', 'polite');
    doc.body.appendChild(alertStack);

    modeSwitch = buildModeSwitch();
    doc.body.appendChild(modeSwitch);

    doc.addEventListener('keydown', handleDialogKeys, true);
    built = true;
  }

  function buildModeSwitch() {
    var wrap = el('div', 'dc-mode-switch');
    wrap.appendChild(el('span', 'dc-mode-switch__label', 'Mode:'));
    modeSwitchValue = el('span', 'dc-mode-switch__value', 'Redesigned In-Page Warnings');
    wrap.appendChild(modeSwitchValue);

    var label = el('label', 'dc-switch');
    modeSwitchInput = doc.createElement('input');
    modeSwitchInput.type = 'checkbox';
    modeSwitchInput.setAttribute('aria-label', 'Switch between redesigned warnings and native browser popups');
    label.appendChild(modeSwitchInput);
    label.appendChild(el('span', 'dc-switch__track'));
    wrap.appendChild(label);

    modeSwitchInput.addEventListener('change', function () {
      AppState.setMode(modeSwitchInput.checked ? AppState.MODES.NATIVE : AppState.MODES.REDESIGNED);
      var native = AppState.isNativeMode();
      if (native) {
        closeModal();
        showAlert('warn', 'Native popup mode on',
          'Warnings now use the browser default alert()/confirm() dialogs so the original, low-friction UI can be tested.');
      } else {
        showAlert('info', 'Redesigned mode on',
          'All four security touchpoints now use the branded in-page warnings.');
      }
    });

    return wrap;
  }

  function renderModeSwitch() {
    if (!modeSwitchInput) { return; }
    var native = AppState.isNativeMode();
    modeSwitchInput.checked = native;
    modeSwitch.classList.toggle('is-native', native);
    modeSwitchValue.textContent = native ? 'Original Native Popups' : 'Redesigned In-Page Warnings';
  }

  function handleDialogKeys(event) {
    if (!overlay || !overlay.classList.contains('is-open')) { return; }

    if (event.key === 'Escape') {
      if (activeConfig && activeConfig.dismissible === false) { return; }
      event.preventDefault();
      closeModal();
      return;
    }

    if (event.key !== 'Tab') { return; }

    var focusables = queryAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', dialog)
      .filter(function (node) { return node.getClientRects().length > 0; });
    if (!focusables.length) { return; }
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------
     modal API
     --------------------------------------------------------- */

  function openModal(config) {
    if (!config) { return; }
    buildShell();
    closeModal(true);

    activeConfig = config;
    lastFocused = doc.activeElement;
    previousOverflow = doc.body.style.overflow;

    var classes = ['dc-dialog'];
    if (config.wide) { classes.push('dc-dialog--wide'); }
    if (config.tone) { classes.push('dc-dialog--' + config.tone); }
    dialog.className = classes.join(' ');
    clearNode(dialog);

    var head = el('div', 'dc-dialog__head');
    head.appendChild(el('div', 'dc-dialog__icon', config.icon || '!'));
    var titles = el('div');
    if (config.kicker) { titles.appendChild(el('p', 'dc-dialog__kicker', config.kicker)); }
    titles.appendChild(el('h2', 'dc-dialog__title', config.title || ''));
    head.appendChild(titles);
    dialog.appendChild(head);

    if (config.dismissible !== false) {
      var close = el('button', 'dc-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close dialog');
      close.addEventListener('click', function () { closeModal(); });
      dialog.appendChild(close);
    }

    var body = el('div', 'dc-dialog__body');
    if (typeof config.body === 'string') {
      body.innerHTML = config.body;
    } else if (config.body) {
      body.appendChild(config.body);
    }
    dialog.appendChild(body);

    if (config.actions && config.actions.length) {
      var foot = el('div', 'dc-dialog__foot');
      config.actions.forEach(function (action) {
        var button = el('button', 'dc-btn dc-btn--' + (action.variant || 'primary'), action.label);
        button.type = 'button';
        if (action.id) { button.id = action.id; }
        if (action.disabled) {
          button.disabled = true;
          button.setAttribute('aria-disabled', 'true');
        }
        button.addEventListener('click', function () {
          if (button.disabled) { return; }
          if (typeof action.onClick === 'function') { action.onClick(); }
        });
        foot.appendChild(button);
      });
      dialog.appendChild(foot);
    }

    overlay.classList.add('is-open');
    overlay.removeAttribute('aria-hidden');
    doc.body.style.overflow = 'hidden';
    AppState.openModal(config.id || 'modal');

    if (typeof config.onMount === 'function') { config.onMount(dialog); }

    var focusTarget = dialog.querySelector('input, button.dc-btn--primary, button.dc-btn--danger, button.dc-btn') || dialog;
    focusTarget.focus();
  }

  function closeModal(silent) {
    if (!built) { return; }
    clearTimers();
    if (activeConfig && typeof activeConfig.onClose === 'function') {
      try { activeConfig.onClose(); } catch (err) { /* ignore */ }
    }
    activeConfig = null;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
    clearNode(dialog);
    doc.body.style.overflow = previousOverflow || '';
    if (!silent) { AppState.closeModal(); }
    if (lastFocused && typeof lastFocused.focus === 'function' && doc.contains(lastFocused)) {
      lastFocused.focus();
    }
  }

  /* ---------------------------------------------------------
     in-page alert component
     --------------------------------------------------------- */

  function buildAlert(tone, title, text, options) {
    options = options || {};
    var node = el('div', 'dc-alert dc-alert--' + tone);
    node.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    node.appendChild(el('div', 'dc-alert__icon', ALERT_ICONS[tone] || 'i'));

    var body = el('div', 'dc-alert__body');
    body.appendChild(el('p', 'dc-alert__title', title || ''));
    body.appendChild(el('p', 'dc-alert__text', text || ''));
    if (options.meta) { body.appendChild(el('span', 'dc-alert__meta', options.meta)); }
    node.appendChild(body);

    var close = el('button', 'dc-alert__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss message');
    close.addEventListener('click', function () { if (node.parentNode) { node.parentNode.removeChild(node); } });
    node.appendChild(close);

    return node;
  }

  function showAlert(tone, title, text, options) {
    options = options || {};
    buildShell();
    var node = buildAlert(tone, title, text, options);
    var host = options.container || alertStack;
    host.appendChild(node);
    if (options.timeout) {
      registerTimer(global.setTimeout(function () {
        if (node.parentNode) { node.parentNode.removeChild(node); }
      }, options.timeout));
    }
    return node;
  }

  function clearAlerts(container) {
    if (!container) { return; }
    queryAll('.dc-alert', container).forEach(function (node) {
      if (node.parentNode) { node.parentNode.removeChild(node); }
    });
  }

  function warn(tone, title, text, options) {
    options = options || {};
    if (AppState.isNativeMode()) {
      global.alert(title + '\n\n' + text);
      return null;
    }
    options.timeout = options.timeout || 6000;
    return showAlert(tone, title, text, options);
  }

  /* ---------------------------------------------------------
     TOUCHPOINT 1 - sign-in verification (unrecognized device)
     --------------------------------------------------------- */

  function buildOtpBoxes() {
    var wrap = el('div', 'dc-otp');
    for (var i = 0; i < 6; i++) {
      var box = doc.createElement('input');
      box.type = 'text';
      box.className = 'dc-otp__box';
      box.maxLength = 1;
      box.inputMode = 'numeric';
      box.autocomplete = 'one-time-code';
      box.setAttribute('aria-label', 'Verification digit ' + (i + 1) + ' of 6');
      box.dataset.index = String(i);
      wrap.appendChild(box);
    }

    wrap.addEventListener('input', function (event) {
      var target = event.target;
      if (!target.classList.contains('dc-otp__box')) { return; }
      target.value = target.value.replace(/\D/g, '').slice(-1);
      if (target.value) {
        var next = wrap.querySelector('[data-index="' + (Number(target.dataset.index) + 1) + '"]');
        if (next) { next.focus(); }
      }
      wrap.dispatchEvent(new CustomEvent('dc:otp-change', { bubbles: true }));
    });

    wrap.addEventListener('keydown', function (event) {
      var target = event.target;
      if (!target.classList.contains('dc-otp__box')) { return; }
      if (event.key === 'Backspace' && !target.value) {
        var prev = wrap.querySelector('[data-index="' + (Number(target.dataset.index) - 1) + '"]');
        if (prev) { prev.focus(); prev.value = ''; wrap.dispatchEvent(new CustomEvent('dc:otp-change', { bubbles: true })); }
      }
    });

    wrap.addEventListener('paste', function (event) {
      event.preventDefault();
      var pasted = (event.clipboardData || global.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      if (!pasted) { return; }
      pasted.split('').forEach(function (digit, index) {
        var box = wrap.querySelector('[data-index="' + index + '"]');
        if (box) { box.value = digit; }
      });
      var focusLast = wrap.querySelector('[data-index="' + (pasted.length - 1) + '"]');
      if (focusLast) { focusLast.focus(); }
      wrap.dispatchEvent(new CustomEvent('dc:otp-change', { bubbles: true }));
    });

    return wrap;
  }

  /* ---------------------------------------------------------
     sign-in gate (carts and orders belong to an account)
     --------------------------------------------------------- */

  function currentPageName() {
    var path = global.location.pathname.split('/').pop() || 'shop.html';
    return path.replace(/[^a-zA-Z0-9_.\-]/g, '') || 'shop.html';
  }

  function goToSignIn() {
    global.location.href = 'login.html?next=' + encodeURIComponent(currentPageName());
  }

  function requireSignIn(action) {
    if (AppState.isNativeMode()) {
      var go = global.confirm('Sign in to ' + action + '?\n\nYour cart is saved to your account, so ' +
        'it stays empty until you sign in.');
      if (go) {
        goToSignIn();
      } else {
        global.alert('Sign in to ' + action + '. Your cart is saved to your account.');
      }
      return;
    }

    openModal({
      id: 'signin-required',
      tone: 'info',
      icon: 'i',
      kicker: 'Sign-in required',
      title: 'Sign in to continue',
      body: el('p', null, 'Your cart and orders are saved to your Drip Collectives account, so we need you to ' +
        'sign in before you can ' + action + '. Anything already in your cart stays saved.'),
      actions: [
        { label: 'Not now', variant: 'outline', onClick: function () {
          closeModal();
          showAlert('info', 'No problem',
            'Sign in whenever you are ready \u2014 your cart is waiting on your account.');
        } },
        { label: 'Sign in', variant: 'primary', onClick: goToSignIn }
      ]
    });
  }

  /* ---------------------------------------------------------
     password reveal toggle
     --------------------------------------------------------- */

  var EYE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  var EYE_SLASH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle><line x1="3" y1="3" x2="21" y2="21"></line></svg>';

  function enhancePasswordFields() {
    queryAll('input[type="password"]').forEach(function (input) {
      if (input.getAttribute('data-dc-toggle') === '1' || !input.parentNode) { return; }
      input.setAttribute('data-dc-toggle', '1');

      var wrapper = el('div', 'input-group dc-password');
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-outline-secondary dc-password__toggle';
      button.setAttribute('aria-label', 'Show password');
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('title', 'Show password');
      button.innerHTML = EYE_ICON;

      button.addEventListener('click', function () {
        var hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        button.innerHTML = hidden ? EYE_SLASH_ICON : EYE_ICON;
        button.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
        button.setAttribute('title', hidden ? 'Hide password' : 'Show password');
        button.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        input.focus();
      });

      wrapper.appendChild(button);
    });
  }

  /* ---------------------------------------------------------
     sign-in and registration
     --------------------------------------------------------- */

  function fieldValue(form, id) {
    var field = query('#' + id, form);
    return field && field.value ? field.value : '';
  }

  function authAlertsContainer(form) {
    return query('#dcSignInAlerts', form) || query('#dcAuthAlerts', form);
  }

  function isStrongPassword(value) {
    return /^(?=.*[A-Za-z])(?=.*\d).{8,}$/.test(String(value || ''));
  }

  function handleAuthForm(form, isRegister) {
    var container = authAlertsContainer(form);
    clearAlerts(container);

    var email = fieldValue(form, 'email').trim();
    var password = fieldValue(form, 'password');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      warn('danger', 'Enter a valid email address',
        'We need a working email address before we can verify your identity.', { container: container });
      return false;
    }

    if (isRegister) {
      var name = fieldValue(form, 'fullName').trim();
      var confirmPassword = fieldValue(form, 'confirmPassword');

      if (name.length < 2) {
        warn('danger', 'Enter your full name',
          'Your delivery address needs a name to go with it.', { container: container });
        return false;
      }
      if (!isStrongPassword(password)) {
        warn('danger', 'Choose a stronger password',
          'Use at least 8 characters and include both a letter and a number.', { container: container });
        return false;
      }
      if (password !== confirmPassword) {
        warn('danger', 'Passwords do not match',
          'The confirmation password must be identical to the one you chose.', { container: container });
        return false;
      }
      startSignInVerification(email, name);
      return false;
    }

    if (!AppState.validateCredentials(email, password)) {
      warn('danger', 'Sign-in failed',
        'We could not match those details. Use the demo account: ' + AppState.DEMO_USER.email +
        ' / ' + AppState.DEMO_USER.password, { container: container });
      return false;
    }
    startSignInVerification(email);
    return false;
  }

  function initAuthPages() {
    queryAll('#loginForm, #registerForm').forEach(function (form) {
      var isRegister = form.id === 'registerForm';
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        handleAuthForm(form, isRegister);
      });
    });

    var fill = query('#dcFillDemo');
    if (fill) {
      fill.addEventListener('click', function () {
        var form = query('#loginForm') || query('#registerForm');
        if (!form) { return; }
        var name = query('#fullName', form);
        var email = query('#email', form);
        var password = query('#password', form);
        var confirm = query('#confirmPassword', form);
        if (name && !name.value) { name.value = AppState.DEMO_USER.name; }
        if (email) { email.value = AppState.DEMO_USER.email; }
        if (password) { password.value = AppState.DEMO_USER.password; }
        if (confirm) { confirm.value = AppState.DEMO_USER.password; }
        if (email) { email.focus(); }
      });
    }
  }

  function startSignInVerification(email, profileName) {
    if (AppState.isNativeMode()) {
      global.alert('Unrecognized login attempt detected.\n\nWe\'ve sent a 6-digit verification code to ' + email + '.');
      var code = global.prompt('Enter the 6-digit verification code sent to ' + email + ':');
      if (code === null) { return false; }
      if (!/^\d{6}$/.test(String(code).trim())) {
        global.alert('That code is not valid. Sign-in was cancelled.');
        return false;
      }
      finishSignIn(email, profileName);
      return true;
    }

    var body = el('div');
    var intro = el('p', null,
      (profileName ? 'Welcome, ' + profileName + '. ' : '') +
      'Unrecognized login attempt detected. We\u2019ve sent a 6-digit verification code to ' + email + '.');
    body.appendChild(intro);

    var boxes = buildOtpBoxes();
    body.appendChild(boxes);
    body.appendChild(el('p', 'dc-hint', 'Prototype build \u2014 enter any 6 digits (for example '));
    var hint = body.lastChild;
    var code = el('code', null, '123456');
    hint.appendChild(code);
    hint.appendChild(doc.createTextNode(') to continue.'));

    openModal({
      id: 'signin-verification',
      tone: 'warn',
      icon: '!',
      kicker: 'Security verification',
      title: 'Confirm it\u2019s you',
      body: body,
      actions: [
        {
          label: 'Cancel',
          variant: 'outline',
          onClick: function () {
            closeModal();
            warn('warn', 'Sign-in cancelled', 'We did not log you in. Try again whenever you are ready.');
          }
        },
        {
          id: 'dc-verify-code',
          label: 'Verify & Proceed',
          variant: 'primary',
          disabled: true,
          onClick: function () { finishSignIn(email, profileName); }
        }
      ],
      onMount: function (root) {
        var verify = root.querySelector('#dc-verify-code');
        root.querySelector('.dc-otp').addEventListener('dc:otp-change', function () {
          var filled = queryAll('.dc-otp__box', root).filter(function (box) { return box.value; }).length === 6;
          verify.disabled = !filled;
          if (filled) { verify.removeAttribute('aria-disabled'); } else { verify.setAttribute('aria-disabled', 'true'); }
        });
        var first = root.querySelector('.dc-otp__box');
        if (first) { first.focus(); }
      }
    });
    return true;
  }

  function finishSignIn(email, profileName) {
    AppState.completeSignIn(email, profileName);
    closeModal();
    var params = new URLSearchParams(global.location.search);
    var next = params.get('next') || 'account.html';
    next = next.replace(/[^a-zA-Z0-9_.\-/]/g, '') || 'account.html';
    var joiner = next.indexOf('?') === -1 ? '?' : '&';
    global.location.href = next + joiner + 'welcome=1';
  }

  /* ---------------------------------------------------------
     TOUCHPOINT 2 - checkout security alert
     --------------------------------------------------------- */

  function currentPaymentMethod() {
    var select = query('#dcPaymentMethod');
    return select && select.value ? select.value : 'GCash';
  }

  function currentAddress() {
    return 'Block 12, Katipunan Ave, Quezon City, 1108';
  }

  function buildOrderSummary(summary) {
    var items = el('ul', 'dc-items');
    summary.items.forEach(function (item) {
      var row = el('li');
      if (item.image) {
        var thumb = doc.createElement('img');
        thumb.className = 'dc-items__thumb';
        thumb.src = item.image;
        thumb.alt = '';
        row.appendChild(thumb);
      }
      var name = el('span', 'dc-items__name', item.name);
      name.appendChild(el('span', 'dc-items__meta', 'Size ' + item.size + ' \u00b7 Qty ' + item.qty));
      row.appendChild(name);
      row.appendChild(el('span', 'dc-items__price', peso(item.price * item.qty)));
      items.appendChild(row);
    });

    var table = el('dl', 'dc-summary');
    var rows = [
      ['Order items', summary.items.length + ' item' + (summary.items.length === 1 ? '' : 's')],
      ['Subtotal', peso(summary.subtotal)],
      ['Shipping', summary.shipping === 0 ? 'Free' : peso(summary.shipping)],
      ['Payment method', summary.payment],
      ['Deliver to', summary.address]
    ];
    rows.forEach(function (pair) {
      var row = el('div', 'dc-summary__row');
      var dt = doc.createElement('dt');
      dt.textContent = pair[0];
      var dd = doc.createElement('dd');
      dd.textContent = pair[1];
      row.appendChild(dt);
      row.appendChild(dd);
      table.appendChild(row);
    });
    var totalRow = el('div', 'dc-summary__row dc-summary__row--total');
    var totalLabel = doc.createElement('dt');
    totalLabel.textContent = 'Total to pay';
    var totalValue = doc.createElement('dd');
    totalValue.textContent = peso(summary.total);
    totalRow.appendChild(totalLabel);
    totalRow.appendChild(totalValue);
    table.appendChild(totalRow);

    var security = el('div', 'dc-security');
    security.appendChild(el('span', 'dc-security__title', 'Security status'));
    var list = el('ul');
    ['Encrypted session (TLS 1.3)', 'Payment details are never stored on this device', 'Account verified as ' + summary.email]
      .forEach(function (line) { list.appendChild(el('li', null, line)); });
    security.appendChild(list);

    var fragment = el('div');
    fragment.appendChild(items);
    fragment.appendChild(table);
    fragment.appendChild(security);
    return fragment;
  }

  function startCheckout() {
    if (!AppState.isLoggedIn()) {
      requireSignIn('place your order');
      return;
    }

    var cart = AppState.getCart();
    if (!cart.length) {
      warn('warn', 'Your cart is empty', 'Add at least one item from the shop before placing an order.');
      return;
    }

    var user = AppState.getUser();
    var summary = {
      items: cart.map(function (item) {
        return { name: item.name, price: item.price, size: item.size, qty: item.qty, image: item.image };
      }),
      subtotal: AppState.getCartSubtotal(),
      shipping: AppState.getShipping(),
      payment: currentPaymentMethod(),
      address: currentAddress(),
      email: user ? user.email : AppState.DEMO_USER.email
    };
    summary.total = summary.subtotal + summary.shipping;

    if (AppState.isNativeMode()) {
      var lines = ['Place your order?', ''];
      summary.items.forEach(function (item) {
        lines.push(item.name + ' x' + item.qty + ' - ' + peso(item.price * item.qty));
      });
      lines.push('', 'Subtotal: ' + peso(summary.subtotal));
      lines.push('Shipping: ' + (summary.shipping === 0 ? 'Free' : peso(summary.shipping)));
      lines.push('Total: ' + peso(summary.total));
      lines.push('Payment: ' + summary.payment);
      if (global.confirm(lines.join('\n'))) {
        completeOrder(summary);
      } else {
        global.alert('Order cancelled. Your cart is still saved.');
      }
      return;
    }

    openModal({
      id: 'checkout-security',
      tone: 'warn',
      icon: '!',
      kicker: 'Checkout security alert',
      title: 'Review before you confirm',
      body: buildOrderSummary(summary),
      wide: true,
      actions: [
        { label: 'Cancel', variant: 'outline', onClick: function () {
          closeModal();
          showAlert('info', 'Order cancelled', 'Nothing was charged. Your cart is still saved.');
        } },
        { label: 'Confirm Order', variant: 'primary', onClick: function () { completeOrder(summary); } }
      ]
    });
  }

  function completeOrder(summary) {
    var order = AppState.placeOrder(summary);
    if (!order) {
      requireSignIn('place your order');
      return;
    }
    closeModal();

    if (AppState.isNativeMode()) {
      global.alert('Order placed.\n\nOrder ID: ' + order.id + '\nTotal: ' + peso(order.total));
      global.location.href = 'shop.html';
      return;
    }

    var body = el('div');
    body.appendChild(el('p', null, 'Thanks ' + (AppState.getUser() ? AppState.getUser().name.split(' ')[0] : 'sneaker') +
      '. We emailed a receipt and your parcel is queued for dispatch within 24 hours.'));
    var table = el('dl', 'dc-summary');
    [
      ['Order ID', order.id],
      ['Payment method', order.payment],
      ['Items', order.items.length + ' item' + (order.items.length === 1 ? '' : 's')],
      ['Total paid', peso(order.total)]
    ].forEach(function (pair) {
      var row = el('div', 'dc-summary__row');
      var dt = doc.createElement('dt');
      dt.textContent = pair[0];
      var dd = doc.createElement('dd');
      dd.textContent = pair[1];
      row.appendChild(dt);
      row.appendChild(dd);
      table.appendChild(row);
    });
    body.appendChild(table);

    openModal({
      id: 'order-success',
      tone: 'success',
      icon: '✓',
      kicker: 'Order confirmed',
      title: 'Order placed successfully',
      body: body,
      dismissible: false,
      actions: [
        { label: 'Continue shopping', variant: 'primary', onClick: function () { global.location.href = 'shop.html'; } }
      ]
    });
  }

  /* ---------------------------------------------------------
     TOUCHPOINT 3 - account deletion with friction
     --------------------------------------------------------- */

  function startAccountDeletion() {
    var user = AppState.getUser();
    var email = user ? user.email : AppState.DEMO_USER.email;

    if (AppState.isNativeMode()) {
      var confirmed = global.confirm(
        'Permanently delete the account ' + email + '?\n\n' +
        'This removes your saved details, order history and empties your cart. This cannot be undone.'
      );
      if (confirmed) {
        performAccountDeletion();
      } else {
        global.alert('Account deletion cancelled. Nothing was changed.');
      }
      return;
    }

    var body = el('div');
    body.appendChild(el('p', null,
      'You are about to permanently delete the account ' + email + '. This is a security-critical action and cannot be undone.'));

    var checklist = el('ul', 'dc-checklist');
    ['Your saved address and payment preferences are erased',
      'Order history for this account is removed',
      'Your cart is emptied and any pending payment proof is discarded',
      'The email address can be reused for a new account'].forEach(function (line) {
      checklist.appendChild(el('li', null, line));
    });
    body.appendChild(checklist);

    var countdown = el('div', 'dc-countdown');
    var value = el('span', 'dc-countdown__value', '10');
    var hint = el('span', null, 'second(s) before you can confirm.');
    countdown.appendChild(el('span', null, 'Confirmation unlocks in'));
    countdown.appendChild(value);
    countdown.appendChild(hint);
    body.appendChild(countdown);
    body.appendChild(el('p', 'dc-help',
      'Prototype build: this site has no backend, so this action clears the data stored in this browser only. ' +
      'Nothing is removed from a server, no confirmation email is sent, and anyone can sign up again with the same address immediately.'));

    openModal({
      id: 'account-deletion',
      tone: 'danger',
      icon: '!',
      kicker: 'Account deletion warning',
      title: 'Delete your account?',
      body: body,
      actions: [
        { label: 'Keep my account', variant: 'outline', onClick: function () {
          closeModal();
          showAlert('info', 'Nothing was deleted', 'Your account is safe and still active.');
        } },
        { id: 'dc-confirm-delete', label: 'Permanently Delete', variant: 'danger', disabled: true, onClick: performAccountDeletion }
      ],
      onMount: function (root) {
        var confirmButton = root.querySelector('#dc-confirm-delete');
        var remaining = 10;
        var tick = global.setInterval(function () {
          remaining -= 1;
          if (remaining > 0) {
            value.textContent = String(remaining);
            return;
          }
          global.clearInterval(tick);
          value.textContent = '0';
          countdown.classList.add('is-done');
          hint.textContent = 'You can now confirm deletion if you are sure.';
          confirmButton.disabled = false;
          confirmButton.removeAttribute('aria-disabled');
        }, 1000);
        registerTimer(tick);
      }
    });
  }

  function performAccountDeletion() {
    AppState.deleteAccount();
    if (AppState.isNativeMode()) {
      global.alert('Your account has been deleted.');
      global.location.href = 'index.html';
      return;
    }
    closeModal();
    showAlert('success', 'Account deleted',
      'Your session was cleared and your cart was emptied. Taking you back to the home page.');
    registerTimer(global.setTimeout(function () { global.location.href = 'index.html'; }, 1400));
  }

  /* ---------------------------------------------------------
     TOUCHPOINT 4 - file upload type warning
     --------------------------------------------------------- */

  function bindUpload(input, options) {
    if (!input) { return; }
    options = options || {};
    boundUploads.push(input);
    syncUploadAccept();
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      handleSelectedFile(input, file, options);
    });
  }

  function handleSelectedFile(input, file, options) {
    if (!file) { return; }
    var extension = AppState.extensionOf(file.name);
    var blocked = AppState.isBlockedExtension(extension) || !AppState.isAllowedExtension(extension);
    if (blocked) {
      blockUpload(input, file, options);
    } else {
      acceptUpload(input, file, options);
    }
  }

  function blockUpload(input, file, options) {
    input.value = '';
    if (options.preview) { clearNode(options.preview); }
    var rejected = 'Rejected file: ' + file.name + (file.type ? ' (' + file.type + ')' : '');

    if (AppState.isNativeMode()) {
      global.alert(UNSUPPORTED_FILE_MESSAGE + '\n\n' + rejected);
      return;
    }
    clearAlerts(options.container);
    showAlert('danger', 'Upload blocked', UNSUPPORTED_FILE_MESSAGE, {
      container: options.container,
      meta: rejected
    });
  }

  function acceptUpload(input, file, options) {
    if (AppState.isNativeMode()) { return; }

    clearAlerts(options.container);
    showAlert('success', 'File accepted', file.name + ' passed the file type check.', {
      container: options.container,
      timeout: 5000
    });

    if (options.preview) {
      clearNode(options.preview);
      var row = el('div', 'dc-preview');
      if (global.FileReader) {
        var reader = new global.FileReader();
        reader.onload = function (event) {
          var img = doc.createElement('img');
          img.src = event.target.result;
          img.alt = '';
          row.insertBefore(img, row.firstChild);
        };
        reader.readAsDataURL(file);
      }
      row.appendChild(el('span', null, file.name + ' \u00b7 ' + Math.max(1, Math.round(file.size / 1024)) + ' KB'));
      options.preview.appendChild(row);
    }
  }

  /* ---------------------------------------------------------
     shared page wiring
     --------------------------------------------------------- */

  function renderNavbar() {
    var count = AppState.getCartCount();
    queryAll('a[href="cart.html"]').forEach(function (link) {
      var badge = query('.dc-cart-badge', link);
      if (!badge) {
        badge = el('span', 'dc-cart-badge badge badge-dark');
        link.appendChild(badge);
      }
      badge.textContent = count ? String(count) : '';
      badge.style.display = count ? 'inline-block' : 'none';
      link.setAttribute('title', count ? count + ' item(s) in cart' : 'Cart is empty');
    });

    queryAll('a[href="login.html"], a[href="account.html"]').forEach(function (link) {
      var loggedIn = AppState.isLoggedIn();
      var user = AppState.getUser();
      link.setAttribute('href', loggedIn ? 'account.html' : 'login.html');
      link.setAttribute('title', loggedIn ? 'Account settings (' + (user ? user.email : '') + ')' : 'Sign in');
      link.setAttribute('aria-label', link.getAttribute('title'));
    });
  }

  function notifyAdded(name) {
    if (AppState.isNativeMode()) {
      global.alert('Added to cart: ' + name + '\n\nItems in cart: ' + AppState.getCartCount());
      return;
    }
    var node = showAlert('success', 'Added to bag', name + ' \u2014 ' + AppState.getCartCount() + ' item(s) in your cart.', {
      timeout: 5000
    });
    var link = el('a', 'dc-toast-link', 'View cart');
    link.href = 'cart.html';
    link.style.marginLeft = '10px';
    node.querySelector('.dc-alert__text').appendChild(link);
  }

  function enhanceProductCards() {
    queryAll('.card').forEach(function (card) {
      var body = query('.card-body', card);
      if (!body) { return; }
      var title = query('.card-title', body);
      var cta = query('a.btn, button.btn', body);
      if (!title || !cta || cta.getAttribute('data-dc-product')) { return; }
      var price = parsePrice((query('.card-text', body) || {}).textContent);
      if (price === null) { return; }

      var image = card.querySelector('img');
      var name = title.textContent.trim();

      cta.setAttribute('data-dc-product', '1');
      cta.setAttribute('href', '#');
      cta.textContent = 'Add to Cart';
      cta.setAttribute('aria-label', 'Add ' + name + ' to cart');
      cta.addEventListener('click', function (event) {
        event.preventDefault();
        if (!AppState.isLoggedIn()) {
          requireSignIn('add "' + name + '" to your cart');
          return;
        }
        var entry = AppState.addToCart({
          name: name,
          price: price,
          image: image ? image.getAttribute('src') : '',
          size: 'M',
          stock: 10
        });
        if (entry) { notifyAdded(name); }
      });
    });
  }

  /* ---------------------------------------------------------
     cart page
     --------------------------------------------------------- */

  function initCartPage() {
    var body = query('#dcCartBody');
    if (!body) { return; }

    /* Edits made here patch a single cell, so the table must not be
       re-rendered underneath the field the user is typing in. */
    var suppressRender = false;

    function updateTotals() {
      var cart = AppState.getCart();
      setText('#dcCartCount', String(AppState.getCartCount()));
      setText('#dcCartSubtotal', peso(AppState.getCartSubtotal()));
      setText('#dcCartShipping', AppState.getCartSubtotal() === 0
        ? peso(0)
        : (AppState.getShipping() === 0 ? 'Free' : peso(AppState.getShipping())));
      setText('#dcCartTotal', peso(AppState.getCartTotal()));
      var placeOrder = query('#dcPlaceOrder');
      if (placeOrder) { placeOrder.disabled = cart.length === 0; }
    }

    function renderCart() {
      var cart = AppState.getCart();
      clearNode(body);

      if (!cart.length) {
        var row = doc.createElement('tr');
        var cell = doc.createElement('td');
        cell.colSpan = 7;
        var empty = el('div', 'dc-empty');
        if (AppState.isLoggedIn()) {
          empty.appendChild(el('h3', null, 'Your cart is empty'));
          empty.appendChild(el('p', null, 'Add a few pieces from the shop to get started.'));
          var link = el('a', 'btn btn-dark', 'Browse the shop');
          link.href = 'shop.html';
          empty.appendChild(link);
        } else {
          empty.appendChild(el('h3', null, 'Sign in to start shopping'));
          empty.appendChild(el('p', null, 'Your cart is saved to your Drip Collectives account, so it stays empty until you sign in.'));
          var signInLink = el('a', 'btn btn-dark', 'Sign in');
          signInLink.href = 'login.html?next=cart.html';
          empty.appendChild(signInLink);
        }
        cell.appendChild(empty);
        row.appendChild(cell);
        body.appendChild(row);
      } else {
        cart.forEach(function (item) {
          var row = doc.createElement('tr');
          row.setAttribute('data-id', item.id);

          var imageCell = doc.createElement('td');
          if (item.image) {
            var img = doc.createElement('img');
            img.src = item.image;
            img.alt = item.name;
            img.width = 80;
            imageCell.appendChild(img);
          }
          row.appendChild(imageCell);

          var nameCell = doc.createElement('td');
          nameCell.appendChild(el('strong', null, item.name));
          row.appendChild(nameCell);

          var sizeCell = doc.createElement('td');
          var sizeSelect = doc.createElement('select');
          sizeSelect.className = 'form-control form-control-sm dc-cart-size';
          SIZE_OPTIONS.forEach(function (size) {
            var option = doc.createElement('option');
            option.value = size;
            option.textContent = size;
            if (size === item.size) { option.selected = true; }
            sizeSelect.appendChild(option);
          });
          sizeCell.appendChild(sizeSelect);
          row.appendChild(sizeCell);

          var priceCell = doc.createElement('td');
          priceCell.appendChild(el('span', null, peso(item.price)));
          row.appendChild(priceCell);

          var qtyCell = doc.createElement('td');
          var qtyInput = doc.createElement('input');
          qtyInput.type = 'number';
          qtyInput.className = 'form-control form-control-sm quantity-input text-center dc-cart-qty';
          qtyInput.value = item.qty;
          qtyInput.min = 1;
          qtyInput.max = item.stock;
          qtyInput.style.width = '80px';
          qtyCell.appendChild(qtyInput);
          qtyCell.appendChild(el('small', 'text-muted d-block', 'Stock: ' + item.stock));
          row.appendChild(qtyCell);

          var subtotalCell = doc.createElement('td');
          subtotalCell.className = 'subtotal';
          subtotalCell.textContent = peso(item.price * item.qty);
          row.appendChild(subtotalCell);

          var actionCell = doc.createElement('td');
          var remove = el('button', 'btn btn-sm btn-danger btn-remove', 'Remove');
          remove.type = 'button';
          actionCell.appendChild(remove);
          row.appendChild(actionCell);

          body.appendChild(row);
        });
      }

      updateTotals();
    }

    /* Quantity and size edits patch the affected row only - re-rendering the
       whole table would steal focus while the user is still typing. */
    function handleCartFieldChange(event) {
      var target = event.target;
      if (!target.classList) { return; }
      var row = target.closest('tr');
      if (!row) { return; }
      var id = row.getAttribute('data-id');

      if (target.classList.contains('dc-cart-size')) {
        suppressRender = true;
        AppState.updateCartItem(id, { size: target.value });
        suppressRender = false;
        return;
      }

      if (!target.classList.contains('dc-cart-qty')) { return; }

      var item = AppState.getCart().filter(function (entry) { return entry.id === id; })[0];
      var requested = parseInt(target.value, 10);
      if (isNaN(requested)) { return; }
      if (requested < 1) {
        target.value = 1;
        requested = 1;
      }
      if (item && requested > item.stock) {
        target.value = item.stock;
        requested = item.stock;
        warn('warn', 'Stock limit reached',
          'Only ' + item.stock + ' unit(s) of ' + item.name + ' are available.',
          { container: query('#dcCartAlerts') });
      }
      suppressRender = true;
      AppState.updateCartItem(id, { qty: requested });
      suppressRender = false;

      var updated = AppState.getCart().filter(function (entry) { return entry.id === id; })[0];
      var subtotal = row.querySelector('.subtotal');
      if (updated && subtotal) { subtotal.textContent = peso(updated.price * updated.qty); }
      updateTotals();
    }

    body.addEventListener('input', handleCartFieldChange);
    body.addEventListener('change', handleCartFieldChange);

    body.addEventListener('click', function (event) {
      var button = event.target.closest('.btn-remove');
      if (!button) { return; }
      var row = button.closest('tr');
      var id = row && row.getAttribute('data-id');
      if (id) { AppState.removeCartItem(id); }
    });

    var placeOrder = query('#dcPlaceOrder');
    if (placeOrder) { placeOrder.addEventListener('click', startCheckout); }

    var clear = query('#dcClearCart');
    if (clear) {
      clear.addEventListener('click', function () {
        if (!AppState.getCart().length) { return; }
        if (AppState.isNativeMode()) {
          if (global.confirm('Remove all items from your cart?')) { AppState.clearCart(); }
        } else {
          AppState.clearCart();
          showAlert('info', 'Cart cleared', 'All items were removed.');
        }
      });
    }

    bindUpload(query('#dcPaymentProof'), { container: query('#dcProofAlerts') });

    AppState.subscribe(function () {
      if (!suppressRender) { renderCart(); }
    });
  }

  function setText(selector, text) {
    var node = query(selector);
    if (node) { node.textContent = text; }
  }

  /* ---------------------------------------------------------
     account page
     --------------------------------------------------------- */

  function initAccountPage() {
    var root = query('#dcAccountRoot');
    if (!root) { return; }

    function renderSignedOut() {
      clearNode(root);
      var panel = el('div', 'dc-panel');
      panel.appendChild(el('div', 'dc-panel__head', 'Account settings'));
      var body = el('div', 'dc-panel__body');
      var empty = el('div', 'dc-empty');
      empty.appendChild(el('h3', null, 'You are not signed in'));
      empty.appendChild(el('p', null, 'Sign in with the demo account to manage your profile and security settings.'));
      var link = el('a', 'btn btn-dark', 'Go to sign in');
      link.href = 'login.html';
      empty.appendChild(link);
      body.appendChild(empty);
      panel.appendChild(body);
      root.appendChild(panel);
    }

    function renderSignedIn() {
      clearNode(root);
      var user = AppState.getUser() || {};
      var orders = AppState.getOrders();

      var grid = el('div', 'row');

      /* profile + photo upload */
      var profileCol = el('div', 'col-lg-7 mb-4');
      var profile = el('div', 'dc-panel');
      profile.appendChild(el('div', 'dc-panel__head', 'Profile'));
      var profileBody = el('div', 'dc-panel__body');

      var profileHead = el('div', 'dc-profile');
      var avatar = el('div', 'dc-avatar dc-avatar--empty', (user.name || 'D C').split(' ').map(function (part) { return part.charAt(0); }).join('').slice(0, 2));
      profileHead.appendChild(avatar);
var meta = el('div', 'dc-meta');
      meta.appendChild(el('strong', null, user.name || 'Demo shopper'));
      meta.appendChild(doc.createTextNode(user.email || ''));
      meta.appendChild(doc.createElement('br'));
      meta.appendChild(doc.createTextNode('Member since ' + (user.joined || '2025') + ' \u00b7 ' + orders.length + ' order(s)'));
      profileHead.appendChild(meta);
      profileBody.appendChild(profileHead);

      var alerts = el('div');
      alerts.id = 'dcPhotoAlerts';
      profileBody.appendChild(alerts);

      var zone = el('label', 'dc-dropzone');
      var photoInput = doc.createElement('input');
      photoInput.type = 'file';
      photoInput.id = 'dcPhotoInput';
      photoInput.name = 'profilePhoto';
      zone.appendChild(photoInput);
      zone.appendChild(el('div', 'dc-dropzone__title', 'Upload profile photo'));
      zone.appendChild(el('div', 'dc-dropzone__hint', 'Click to choose a file \u00b7 only .png and .jpg are accepted'));
      profileBody.appendChild(zone);

      var preview = el('div');
      preview.id = 'dcPhotoPreview';
      profileBody.appendChild(preview);

      profileBody.appendChild(el('p', 'dc-help',
        'Try it: pick a file like notes.exe, script.js or run.sh to see the upload warning, then pick any .png or .jpg to see it accepted.'));

      /* Two-step sign out: first click only arms the button, second click signs out.
         No popup in either mode. */
      var signOut = el('button', 'btn btn-outline-dark', 'Sign out');
      signOut.type = 'button';
      signOut.id = 'dcSignOut';
      signOut.style.marginTop = '16px';

      var signOutHint = el('p', 'dc-help dc-signout-hint');
      signOutHint.style.display = 'none';
      var signOutArmed = false;
      var signOutTimer = null;

      function disarmSignOut() {
        signOutArmed = false;
        signOut.textContent = 'Sign out';
        signOut.classList.remove('btn-danger');
        signOut.classList.add('btn-outline-dark');
        signOutHint.style.display = 'none';
        if (signOutTimer) { global.clearTimeout(signOutTimer); signOutTimer = null; }
      }

      function armSignOut() {
        signOutArmed = true;
        signOut.textContent = 'Sure?';
        signOut.classList.remove('btn-outline-dark');
        signOut.classList.add('btn-danger');
        signOutHint.textContent = 'Click again to sign out \u00b7 this resets in 4 seconds';
        signOutHint.style.display = '';
        if (signOutTimer) { global.clearTimeout(signOutTimer); }
        signOutTimer = global.setTimeout(disarmSignOut, 4000);
      }

      signOut.addEventListener('click', function () {
        if (!signOutArmed) {
          armSignOut();
          return;
        }
        disarmSignOut();
        var hadItems = AppState.getCartCount() > 0;
        AppState.signOut();
        renderAccount();
        showAlert('info', 'Signed out',
          'You have been signed out of this device.' +
          (hadItems ? ' Your cart was cleared because carts are saved per account.' : ''));
      });
      profileBody.appendChild(signOut);
      profileBody.appendChild(signOutHint);

      profile.appendChild(profileBody);
      profileCol.appendChild(profile);
      grid.appendChild(profileCol);

      /* payment proof upload */
      var proofCol = el('div', 'col-lg-5 mb-4');
      var proof = el('div', 'dc-panel');
      proof.appendChild(el('div', 'dc-panel__head', 'Payment proof'));
      var proofBody = el('div', 'dc-panel__body');
      var proofAlerts = el('div');
      proofAlerts.id = 'dcProofAlerts';
      proofBody.appendChild(proofAlerts);
      var proofZone = el('label', 'dc-dropzone');
      var proofInput = doc.createElement('input');
      proofInput.type = 'file';
      proofInput.id = 'dcAccountProof';
      proofInput.name = 'paymentProof';
      proofZone.appendChild(proofInput);
      proofZone.appendChild(el('div', 'dc-dropzone__title', 'Attach payment proof'));
      proofZone.appendChild(el('div', 'dc-dropzone__hint', 'Screenshot of your GCash / Maya transfer'));
      proofBody.appendChild(proofZone);
      proof.appendChild(proofBody);
      proofCol.appendChild(proof);
      grid.appendChild(proofCol);

      /* danger zone */
      var dangerCol = el('div', 'col-12');
      var danger = el('div', 'dc-panel dc-danger-zone');
      danger.appendChild(el('div', 'dc-panel__head', 'Danger zone'));
      var dangerBody = el('div', 'dc-panel__body');
      dangerBody.appendChild(el('p', 'mb-2', 'Deleting your account removes your profile, order history and cart. This cannot be undone.'));
      var deleteButton = el('button', 'btn btn-danger', 'Delete Account');
      deleteButton.type = 'button';
      deleteButton.id = 'dcDeleteAccount';
      deleteButton.addEventListener('click', startAccountDeletion);
      dangerBody.appendChild(deleteButton);
      danger.appendChild(dangerBody);
      dangerCol.appendChild(danger);
      grid.appendChild(dangerCol);

      root.appendChild(grid);

      bindUpload(photoInput, { container: alerts, preview: preview });
      bindUpload(proofInput, { container: proofAlerts });
    }

    function renderAccount() {
      if (AppState.isLoggedIn()) {
        renderSignedIn();
      } else {
        renderSignedOut();
      }
    }

    renderAccount();

    var params = new URLSearchParams(global.location.search);
    if (params.get('welcome') === '1' && AppState.isLoggedIn()) {
      showAlert('success', 'Welcome', 'Your session is active as ' + AppState.getUser().email + '.');
      params.delete('welcome');
      var queryString = params.toString();
      global.history.replaceState({}, '', global.location.pathname + (queryString ? '?' + queryString : ''));
    }
  }

  /* ---------------------------------------------------------
     boot
     --------------------------------------------------------- */

  function init() {
    if (built && initialized) { return; }
    initialized = true;
    buildShell();
    renderModeSwitch();

    AppState.subscribe(function () {
      renderModeSwitch();
      syncUploadAccept();
      renderNavbar();
    });

    enhanceProductCards();
    enhancePasswordFields();
    initAuthPages();
    initCartPage();
    initAccountPage();
    renderNavbar();
  }

  global.DripUI = {
    openModal: openModal,
    closeModal: closeModal,
    showAlert: showAlert,
    signInVerification: startSignInVerification,
    handleSignInForm: handleAuthForm,
    placeOrder: startCheckout,
    deleteAccount: startAccountDeletion,
    bindUpload: bindUpload,
    handleSelectedFile: handleSelectedFile,
    UNSUPPORTED_FILE_MESSAGE: UNSUPPORTED_FILE_MESSAGE
  };

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window, document);
