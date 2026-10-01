/* ============================================================
   DRIP COLLECTIVES - Client-side application state
   No backend. Everything lives in memory + localStorage.
   Exposes: window.AppState
   ============================================================ */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'drip.collectives.state.v1';
  var SHIPPING_FLAT = 150;

  var MODES = {
    REDESIGNED: 'redesigned',
    NATIVE: 'native'
  };

  /* Hardcoded demo account used by every security touchpoint. */
  var DEMO_USER = {
    email: 'user@tip.edu.ph',
    password: 'Samplepass123!',
    name: 'Camille Reyes',
    handle: '@camille',
    joined: 'March 2025'
  };

  /* Touchpoint 4 - upload allowlist / denylist */
  var ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
  var BLOCKED_EXTENSIONS = [
    '.exe', '.bat', '.cmd', '.sh', '.js', '.mjs', '.vbs', '.ps1', '.php',
    '.jar', '.msi', '.scr', '.com', '.pif', '.hta', '.reg', '.apk', '.dll',
    '.py', '.rb', '.svg'
  ];

  function defaults() {
    return {
      isLoggedIn: false,
      cart: [],
      currentModal: null,
      mode: MODES.REDESIGNED,
      user: null,
      orders: []
    };
  }

  var listeners = [];
  var state = load();

  function load() {
    var base = defaults();
    var raw;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return base;
    }
    if (!raw) { return base; }
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') { return base; }
      return {
        isLoggedIn: parsed.isLoggedIn === true,
        cart: Array.isArray(parsed.cart) ? parsed.cart : [],
        currentModal: typeof parsed.currentModal === 'string' ? parsed.currentModal : null,
        mode: parsed.mode === MODES.NATIVE ? MODES.NATIVE : MODES.REDESIGNED,
        user: parsed.user && parsed.user.email ? parsed.user : null,
        orders: Array.isArray(parsed.orders) ? parsed.orders : []
      };
    } catch (err) {
      return base;
    }
  }

  function commit() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) { /* private mode / quota - keep working in memory */ }
    notify();
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (err) { /* listener errors never break state */ }
    }
  }

  function publicUser(email, name) {
    return {
      email: email || DEMO_USER.email,
      name: name || DEMO_USER.name,
      handle: DEMO_USER.handle,
      joined: DEMO_USER.joined,
      signedInAt: new Date().toISOString()
    };
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- auth ---------------- */

  function validateCredentials(email, password) {
    return String(email || '').trim().toLowerCase() === DEMO_USER.email &&
      String(password || '') === DEMO_USER.password;
  }

  function completeSignIn(email, name) {
    state.isLoggedIn = true;
    state.user = publicUser(email, name);
    commit();
    return state.user;
  }

  function signOut() {
    state.isLoggedIn = false;
    state.user = null;
    state.cart = [];
    state.currentModal = null;
    commit();
  }

  function deleteAccount() {
    state.isLoggedIn = false;
    state.user = null;
    state.cart = [];
    state.orders = [];
    state.currentModal = null;
    commit();
  }

  /* ---------------- cart ---------------- */

  function getCart() { return state.cart; }
  function getCartCount() {
    return state.cart.reduce(function (sum, item) { return sum + item.qty; }, 0);
  }
  function getCartSubtotal() {
    return state.cart.reduce(function (sum, item) { return sum + item.price * item.qty; }, 0);
  }
  function getShipping() {
    var subtotal = getCartSubtotal();
    if (subtotal === 0) { return 0; }
    return subtotal >= 3000 ? 0 : SHIPPING_FLAT;
  }
  function getCartTotal() { return getCartSubtotal() + getShipping(); }

  /* Carts are tied to an account, so these refuse to mutate while signed out. */
  function addToCart(item) {
    if (!state.isLoggedIn) { return null; }
    var entry = {
      id: item.id || uid('dc'),
      name: item.name || 'Untitled item',
      price: Number(item.price) || 0,
      image: item.image || '',
      size: item.size || 'M',
      stock: Number(item.stock) || 10,
      qty: Math.max(1, Number(item.qty) || 1)
    };
    var key = entry.name + '::' + entry.size;
    var existing = null;
    for (var i = 0; i < state.cart.length; i++) {
      if (state.cart[i].name + '::' + state.cart[i].size === key) { existing = state.cart[i]; break; }
    }
    if (existing) {
      existing.qty = Math.min(existing.stock, existing.qty + entry.qty);
    } else {
      state.cart.push(entry);
    }
    commit();
    return entry;
  }

  function updateCartItem(id, patch) {
    var found = null;
    for (var i = 0; i < state.cart.length; i++) {
      if (state.cart[i].id === id) { found = state.cart[i]; break; }
    }
    if (!found) { return null; }
    if (typeof patch.size === 'string' && patch.size) { found.size = patch.size; }
    if (typeof patch.qty === 'number' && !isNaN(patch.qty)) {
      found.qty = Math.min(found.stock, Math.max(1, Math.floor(patch.qty)));
    }
    commit();
    return found;
  }

  function removeCartItem(id) {
    state.cart = state.cart.filter(function (item) { return item.id !== id; });
    commit();
  }

  function clearCart() {
    state.cart = [];
    commit();
  }

  /* ---------------- orders ---------------- */

  function placeOrder(summary) {
    if (!state.isLoggedIn) { return null; }
    var order = {
      id: 'DC-' + Math.floor(100000 + Math.random() * 899999),
      placedAt: new Date().toISOString(),
      items: summary.items.slice(),
      total: summary.total,
      payment: summary.payment,
      shipping: summary.shipping,
      email: summary.email
    };
    state.orders.unshift(order);
    state.cart = [];
    commit();
    return order;
  }

  function getOrders() { return state.orders; }

  /* ---------------- modals + demo mode ---------------- */

  function openModal(name) {
    state.currentModal = name || null;
    commit();
  }

  function closeModal() {
    state.currentModal = null;
    commit();
  }

  function setMode(mode) {
    state.mode = mode === MODES.NATIVE ? MODES.NATIVE : MODES.REDESIGNED;
    commit();
    return state.mode;
  }

  function toggleMode() {
    return setMode(state.mode === MODES.NATIVE ? MODES.REDESIGNED : MODES.NATIVE);
  }

  function isNativeMode() { return state.mode === MODES.NATIVE; }

  function resetAll() {
    state = defaults();
    commit();
  }

  /* ---------------- uploads ---------------- */

  function extensionOf(filename) {
    var name = String(filename || '');
    var dot = name.lastIndexOf('.');
    if (dot === -1) { return ''; }
    return name.slice(dot).toLowerCase();
  }

  function isBlockedExtension(ext) {
    return BLOCKED_EXTENSIONS.indexOf(String(ext).toLowerCase()) !== -1;
  }

  function isAllowedExtension(ext) {
    return ALLOWED_EXTENSIONS.indexOf(String(ext).toLowerCase()) !== -1;
  }

  global.AppState = {
    MODES: MODES,
    DEMO_USER: DEMO_USER,
    ALLOWED_EXTENSIONS: ALLOWED_EXTENSIONS,
    BLOCKED_EXTENSIONS: BLOCKED_EXTENSIONS,
    SHIPPING_FLAT: SHIPPING_FLAT,

    getState: function () { return state; },
    subscribe: function (fn) {
      if (typeof fn === 'function') { listeners.push(fn); }
      fn(state);
      return function () {
        listeners = listeners.filter(function (item) { return item !== fn; });
      };
    },

    validateCredentials: validateCredentials,
    completeSignIn: completeSignIn,
    signOut: signOut,
    deleteAccount: deleteAccount,
    isLoggedIn: function () { return state.isLoggedIn; },
    getUser: function () { return state.user; },

    getCart: getCart,
    getCartCount: getCartCount,
    getCartSubtotal: getCartSubtotal,
    getShipping: getShipping,
    getCartTotal: getCartTotal,
    addToCart: addToCart,
    updateCartItem: updateCartItem,
    removeCartItem: removeCartItem,
    clearCart: clearCart,

    placeOrder: placeOrder,
    getOrders: getOrders,

    openModal: openModal,
    closeModal: closeModal,
    getCurrentModal: function () { return state.currentModal; },
    setMode: setMode,
    toggleMode: toggleMode,
    isNativeMode: isNativeMode,
    getMode: function () { return state.mode; },
    resetAll: resetAll,

    extensionOf: extensionOf,
    isBlockedExtension: isBlockedExtension,
    isAllowedExtension: isAllowedExtension,
    formatPeso: function (value) {
      return '₱' + Number(value || 0).toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    }
  };
})(window);