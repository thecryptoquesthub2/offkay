const state = {
  user: null,
  universities: [],
  listings: [],
  ownListings: [],
  roommateCandidates: [],
  verification: null,
  paymentsEnabled: false,
  discovery: "",
  conversations: [],
  bookings: [],
  inspections: [],
  notifications: [],
  notificationsUnread: 0,
  unreadMessages: 0,
  settingsView: false,
  activeTab: "home",
  activeConversation: null,
  messages: [],
  filters: {
    homes: { query: "", university: "", type: "All", maxPrice: "", bedrooms: "", verified: false },
    roommates: { query: "", university: "", maxBudget: "", habit: "", verified: false },
    people: { query: "", university: "", connected: false }
  },
  exploreMode: "homes",
  hostView: localStorage.getItem("offkay-host-view") === "true",
  theme: localStorage.getItem("offkay-theme") || "offkay"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = value => `&#8358;${Number(value || 0).toLocaleString("en-NG")}`;
const initials = name => String(name || "?").split(/\s+/).map(part => part[0]).join("").slice(0,2).toUpperCase();
// Avatar HTML: photo when the user has one (uploaded or Google), initials otherwise.
const avatarHtml = (name, avatarUrl, cls = "") => avatarUrl
  ? `<span class="avatar ${cls}"><img class="avatar-img" src="${esc(avatarUrl)}" alt="${esc(name || "Avatar")}" loading="lazy"></span>`
  : `<span class="avatar ${cls}">${initials(name)}</span>`;
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const time = iso => new Intl.DateTimeFormat("en-NG",{hour:"numeric",minute:"2-digit"}).format(new Date(iso));
const firstName = name => String(name || "").split(" ")[0];
const mapUrl = listing => {
  const coords = listingCoords(listing);
  return coords
    ? `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lng}#map=17/${coords.lat}/${coords.lng}`
    : `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${listing.area || ""}, ${listing.university || ""}, Nigeria`.replace(/^,\s+|,\s+$/g,""))}`;
};
const icon = name => `<svg class="off-icon" aria-hidden="true"><use href="/offkay-icons.svg#${name}"></use></svg>`;
const canHost = () => state.user?.role === "landlord" || state.user?.hosting === true;
const inHostView = () => canHost() && state.hostView;
const unreadTotal = () => state.conversations.reduce((sum,item)=>sum+(Number(item.unread)||0),0);const KNOWN_THEMES = ["offkay","forest","slate","clay","midnight"];

function applyTheme(theme) {
  if (!KNOWN_THEMES.includes(theme)) theme = "offkay";
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem("offkay-theme", theme);
}
document.body.dataset.theme = KNOWN_THEMES.includes(state.theme) ? state.theme : "offkay";

const isDbDown = error => /database connection failed|waking up|cannot be saved/i.test(String(error?.message || ""));

/* ---- Verification state helpers ------------------------------------------
   State-driven: NOT_VERIFIED (nothing submitted), PENDING (under review),
   VERIFIED (approved — final), REJECTED (rejected, may resubmit). */
function verificationState() {
  return state.verificationStatus || state.verification?.statusLabel || "NOT_VERIFIED";
}

function verificationStatusLabel() {
  const status = verificationState();
  if (status === "VERIFIED") return "Identity verified";
  if (status === "PENDING") return "Verification under review";
  if (status === "REJECTED") {
    return state.verification?.rejectionReason
      ? `Resubmit required — ${state.verification.rejectionReason}`
      : "Rejected — submit clearer documents to try again";
  }
  return "Not submitted";
}

function verificationBadge(statusLabel, submission) {
  if (statusLabel === "VERIFIED") {
    return `<span class="verified-line">&#10003; Identity verified</span>`;
  }
  if (statusLabel === "PENDING") {
    return `<span class="verified-line pending">&#8987; Verification under review</span>`;
  }
  if (statusLabel === "REJECTED") {
    const reason = submission?.rejectionReason;
    return `<span class="verified-line rejected">&#10007; Verification rejected</span>${reason ? `<small class="verify-reason">Reason: ${esc(reason)}</small>` : ""}`;
  }
  return `<span class="verified-line">&#9676; Not verified yet</span>`;
}

function verificationPanel(statusLabel, submission) {
  if (statusLabel === "VERIFIED") {
    return `<div class="verify-panel verified glass">
      <div>${icon("verified")}<b>You're verified</b></div>
      <p>Your identity documents were reviewed and approved${submission?.reviewedAt ? ` on ${new Date(submission.reviewedAt).toLocaleDateString()}` : ""}. Verification is complete — no further action is needed.</p>
    </div>`;
  }
  if (statusLabel === "PENDING") {
    const submitted = submission?.createdAt ? new Date(submission.createdAt).toLocaleDateString() : null;
    return `<div class="verify-panel pending glass">
      <div>&#8987; <b>Verification under review</b></div>
      <p>We received your documents${submitted ? ` on ${submitted}` : ""}. The Offkay team reviews submissions manually — usually within 24 hours. You'll see the result here.</p>
    </div>`;
  }
  if (statusLabel === "REJECTED") {
    return `<div class="verify-panel rejected glass">
      <div>&#10007; <b>Verification rejected</b></div>
      ${submission?.rejectionReason ? `<p>Reason: ${esc(submission.rejectionReason)}</p>` : ""}
      <p>Check the reason above, prepare clearer documents, and submit again below.</p>
      <button class="button primary" data-action="open-verification">Resubmit verification</button>
    </div>`;
  }
  return `<div class="verify-panel glass">
    <div>&#9676; <b>Verify your identity</b></div>
    <p>Verified students get more roommate matches, and verified hosts get more bookings. It takes about two minutes.</p>
    <button class="button primary" data-action="open-verification">Start verification</button>
  </div>`;
}
const dbDownMessage = () => "Offkay can't reach its database right now - it usually reconnects within a minute. Refresh in a moment.";

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: options.body ? {"Content-Type":"application/json",...(options.headers || {})} : options.headers,
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      try { localStorage.removeItem("offkay-theme"); } catch {}
      showAuth();
      toast("Your session expired - please sign in again");
    }
    throw new Error(payload.error || "Something went wrong");
  }
  return payload;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2400);
}

function setLoading(button, loading, label = "Please wait...") {
  if (!button) return;
  if (loading) {
    button.dataset.original = button.innerHTML;
    button.innerHTML = label;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.original || button.innerHTML;
    button.disabled = false;
  }
}

function modal(content, wide = false) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal glass ${wide ? "wide" : ""}">${content}</div>`;
  root.classList.add("open");
  root.querySelector(".close-button")?.addEventListener("click", closeModal);
}

function closeModal() {
  $("#modalRoot").classList.remove("open");
  $("#modalRoot").innerHTML = "";
  state.openProfileId = null;
}

const FORMS = ["loginForm", "signupForm", "forgotForm", "resetForm"];
const FORM_COPY = {
  loginForm: ["Offkay", "Sign in", "Access your housing, messages, and bookings."],
  signupForm: ["Join Offkay", "Create your account", "One account for housing, roommates, and messages."],
  forgotForm: ["Account help", "Reset your password", "We will email you a secure link to choose a new password."],
  resetForm: ["Account help", "Choose a new password", "Pick a new password for your Offkay account."]
};

function setAuthMode(mode) {
  const active = `${mode}Form`;
  FORMS.forEach(id => $(`#${id}`).classList.toggle("hidden", id !== active));
  const [eyebrow, title, subtitle] = FORM_COPY[active] || FORM_COPY.loginForm;
  $("#authEyebrow").textContent = eyebrow;
  $("#authTitle").textContent = title;
  $("#authSubtitle").textContent = subtitle;
  showAuthBanner("");
}

// Inline status banner above the active auth form (no dead toasts for
// OAuth redirects, reset-link states, or form-level validation errors).
function showAuthBanner(kind, text = "") {
  const banner = $("#authBanner");
  if (!banner) return;
  if (!kind || !text) { banner.classList.add("hidden"); banner.textContent = ""; return; }
  banner.className = `auth-banner ${kind}`;
  banner.textContent = text;
}

function authModeFromForm(form) {
  return form.id.replace(/Form$/, "");
}

// Show/hide password toggles: one delegated listener covers every field,
// including ones inside modals (change-password sheet) and reset.html.
function bindPasswordToggles() {
  document.addEventListener("click", event => {
    const button = event.target.closest(".pw-toggle[data-toggle-for]");
    if (!button) return;
    const input = button.parentElement.querySelector("input");
    if (!input) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.classList.toggle("visible", show);
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
}

/* ---- Forgot password / reset flow --------------------------------------- */
let resetToken = "";

async function forgotPassword(event) {
  event.preventDefault();
  const button = event.submitter;
  setLoading(button, true, "Sending link...");
  showAuthBanner("");
  try {
    const email = String(new FormData(event.currentTarget).get("email") || "").trim();
    const data = await request("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
    setAuthMode("login");
    if (data.delivery === "sent") {
      showAuthBanner("ok", data.message || "If an Offkay account exists for that email, a reset link is on its way.");
    } else if (data.delivery === "failed") {
      // The provider rejected or dropped the message - never claim it was
      // sent. Offer to retry instead.
      showAuthBanner("error", "We could not send the reset email right now. Please try again in a few minutes.");
    } else {
      // Delivery skipped: either no account exists for that email (the
      // endpoint stays deliberately vague) or RESEND_API_KEY is not set.
      showAuthBanner("ok", data.message || "If an Offkay account exists for that email, a reset link is on its way. It expires in 30 minutes.");
      if (data.devMode) showAuthBanner("ok", `${data.message} (Dev mode: no RESEND_API_KEY is configured, so the link is printed in the server console.)`);
    }
  } catch (error) {
    showAuthBanner("error", error.message);
  } finally { setLoading(button, false); }
}

// Entry point from the emailed link (?token=...). Verifies the token, then
// shows the new-password form on the main screen.
async function startResetFlow(token) {
  setAuthMode("reset");
  showAuth();
  resetToken = token;
  showAuthBanner("");
  if (!/^[a-f0-9]{64}$/.test(token)) {
    setAuthMode("forgot");
    showAuthBanner("error", "This password-reset link is invalid. Request a fresh link below.");
    return;
  }
  try {
    await request(`/api/auth/reset/${encodeURIComponent(token)}`);
    showAuthBanner("ok", "Reset link verified. Choose your new password below.");
  } catch (error) {
    setAuthMode("forgot");
    showAuthBanner("error", error.message || "This reset link is invalid or has expired. Request a new one.");
  }
}

async function submitReset(event) {
  event.preventDefault();
  const button = event.submitter;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (values.password !== values.confirmPassword) {
    showAuthBanner("error", "Passwords do not match - re-enter them so both fields are identical.");
    return;
  }
  setLoading(button, true, "Updating password...");
  showAuthBanner("");
  try {
    const data = await request("/api/auth/reset", { method: "POST", body: JSON.stringify({ token: resetToken, password: values.password, confirmPassword: values.confirmPassword }) });
    resetToken = "";
    event.currentTarget.reset();
    setAuthMode("login");
    showAuthBanner("ok", data.message || "Password updated. Sign in with your new password.");
  } catch (error) {
    showAuthBanner("error", error.message);
    if (/invalid or expired/i.test(error.message)) setAuthMode("forgot");
  } finally { setLoading(button, false); }
}

// Post-OAuth landing (?authError=... / ?authSuccess=google) and post-reset
// return (?reset=done) surface their outcome here, then clean the URL.
function consumeAuthQueryFlags() {
  const params = new URLSearchParams(location.search);
  const authError = params.get("authError");
  const resetDone = params.get("reset") === "done";
  const googleSuccess = params.get("authSuccess") === "google";
  if (!authError && !resetDone && !googleSuccess) return;
  params.delete("authError"); params.delete("authSuccess"); params.delete("reset");
  history.replaceState(null, "", location.pathname + (params.toString() ? `?${params}` : ""));
  const banner = (kind, text) => { showAuth(); setAuthMode("login"); showAuthBanner(kind, text); };
  if (authError) return banner("error", authError);
  if (resetDone) return banner("ok", "Password updated. Sign in with your new password.");
  // Google sign-in success is silent: the session cookie is already set and
  // the app bootstraps straight into the signed-in experience.
}

function toggleSignupUniversity(show) {
  const wrap = $("#suUniversityWrap");
  if (!wrap) return;
  const select = wrap.querySelector("select");
  if (show) {
    wrap.classList.remove("collapsed");
    if (select) select.required = true;
  } else {
    wrap.classList.add("collapsed");
    if (select) select.required = false;
  }
}

async function bootstrap() {
  consumeAuthQueryFlags();
  try {
    const data = await request("/api/bootstrap");
    Object.assign(state, data);
    applyTheme(state.theme);
    populateUniversities();
    if (state.user) {
      try { enterApp(); } catch (renderError) {
        console.error("App shell render failed, retrying with guest view:", renderError);
        state.hostView = false;
        localStorage.setItem("offkay-host-view", "false");
        enterApp();
      }
    } else showAuth();
  } catch (error) {
    console.error("Bootstrap failed:", error);
    populateUniversities();
    showAuth();
    toast(isDbDown(error) ? dbDownMessage() : error.message);
  }
}

function populateUniversities() {
  const FALLBACK_UNIVERSITIES = [
    "University of Lagos","University of Ibadan","University of Nigeria, Nsukka",
    "Obafemi Awolowo University","Ahmadu Bello University","University of Benin",
    "University of Ilorin","University of Abuja","University of Port Harcourt",
    "Federal University of Technology, Akure","Federal University of Technology, Minna","Federal University of Technology, Owerri",
    "University of Jos","University of Calabar","University of Uyo",
    "Bayero University Kano","Nnamdi Azikiwe University","Usmanu Danfodiyo University",
    "University of Maiduguri","Federal University Oye-Ekiti","Lagos State University",
    "Olabisi Onabanjo University","Ekiti State University","Adekunle Ajasin University",
    "Delta State University","Rivers State University","Ambrose Alli University",
    "Benue State University","Kaduna State University","Kwara State University",
    "Covenant University","Babcock University","Afe Babalola University",
    "Bowen University","Landmark University","American University of Nigeria",
    "Pan-Atlantic University","Redeemer's University","Lead City University",
    "Nile University of Nigeria","University of Medical Sciences, Ondo","Federal University of Agriculture, Abeokuta",
    "Michael Okpara University of Agriculture","Modibbo Adama University","Abubakar Tafawa Balewa University",
    "Federal University Dutse","Federal University Lafia","Federal University Lokoja",
    "Federal University Kashere","Alex Ekwueme Federal University"
  ];
  const list = (state.universities && state.universities.length ? state.universities : FALLBACK_UNIVERSITIES);
  const select = $("#su-university");
  if (select) select.innerHTML = list.map(name => `<option>${esc(name)}</option>`).join("");
}

function removeBootSplash() {
  const splash = $("#bootSplash");
  if (splash) splash.remove();
}

function showAuth() {
  removeBootSplash();
  $("#authScreen").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#app").hidden = true;
}

function enterApp() {
  // Defensive guard: never crash on a missing session (e.g. bootstrap race).
  if (!state.user) { showAuth(); return; }
  removeBootSplash();
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#app").hidden = false;
  $("#topAvatar").innerHTML = state.user.avatarUrl
    ? `<img class="avatar-img" src="${esc(state.user.avatarUrl)}" alt="${esc(state.user.name)}">`
    : esc(initials(state.user.name));
  $("#topName").textContent = firstName(state.user.name);
  $("#topRole").textContent = inHostView() ? "Host" : "Guest";
  if (state.user.isCoreAdmin) {
    request("/api/badges").then(b => { state.adminPending = b.adminPending || 0; renderNotificationDot(); }).catch(() => {});
  }
  renderNotificationDot();
  startBadgePolling();
  $("#sidebarCard").innerHTML = inHostView()
    ? `<span>Grow your portfolio</span><strong>Publish a verified property in minutes.</strong><button class="button light small" data-action="new-listing">Add property</button>`
    : `<span>Roommate Match</span><strong>Living is easier with the right person.</strong><button class="button light small" data-action="open-matches">Find a match</button>`;
  renderAll();
}

function renderNotificationDot() {
  const messageCount = Number(state.unreadMessages) || unreadTotal();
  $$(".msg-badge").forEach(node => {
    node.textContent = messageCount > 99 ? "99+" : String(messageCount);
    node.hidden = messageCount === 0;
  });
  const notifCount = Number(state.notificationsUnread) || 0;
  $$(".notif-badge").forEach(node => {
    node.textContent = notifCount > 99 ? "99+" : String(notifCount);
    node.hidden = notifCount === 0;
  });
  const adminCount = Number(state.adminPending) || 0;
  $$(".admin-badge").forEach(node => {
    node.textContent = adminCount > 99 ? "99+" : String(adminCount);
    node.hidden = adminCount === 0;
  });
  const dot = $("#notificationButton i");
  if (dot) dot.style.display = notifCount ? "block" : "none";
}

let badgePoll = null;
function startBadgePolling() {
  stopBadgePolling();
  if (!state.user) return;
  badgePoll = setInterval(async () => {
    if (!state.user || document.hidden) return;
    try {
      const data = await request("/api/badges");
      const changed = data.messages !== state.unreadMessages || data.notifications !== state.notificationsUnread || (data.adminPending || 0) !== (state.adminPending || 0);
      state.unreadMessages = data.messages;
      state.notificationsUnread = data.notifications;
      state.adminPending = data.adminPending || 0;
      renderNotificationDot();
      if (changed) refreshData(false).catch(() => {});
    } catch { /* transient network errors stay silent */ }
  }, 8000);
}
function stopBadgePolling() {
  clearInterval(badgePoll);
  badgePoll = null;
}

const notificationGlyph = type => ({message:"&#9993;",connection:"&#9826;",connection_accepted:"&#10003;",inspection:"&#128197;",booking:"&#8962;",payment:"&#10003;",system:"&#9737;"}[type] || "&#9737;");

function notificationRow(item) {
  return `<button class="notification-row ${item.read ? "" : "unread"}" data-action="open-notification" data-id="${item.id}" data-type="${esc(item.type)}" data-ref="${esc(item.meta?.conversationId || item.meta?.listingId || item.meta?.bookingId || "")}">
    <span class="notification-glyph">${notificationGlyph(item.type)}</span>
    <span class="notification-copy"><b>${esc(item.title)}</b><small>${esc(item.body || "")}</small><time>${new Date(item.createdAt).toLocaleString("en-NG",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</time></span>
    ${item.read ? "" : `<i class="unread-pip"></i>`}
  </button>`;
}

async function openNotifications() {
  if (!state.user) return;
  try {
    const data = await request("/api/notifications");
    state.notifications = data.notifications;
    state.notificationsUnread = data.unread;
  } catch (error) { return toast(error.message); }
  const unreadIds = state.notifications.filter(item => !item.read).map(item => item.id);
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Notifications</span><h2>Activity</h2><p>Connection requests, messages, inspections, and booking updates.</p></div><button class="close-button">&times;</button></div>
    <div class="notification-list">${state.notifications.length ? state.notifications.map(notificationRow).join("") : emptyState("Nothing yet","Requests, messages, and booking updates will land here.")}</div>
    ${state.notifications.length ? `<button class="button subtle wide" data-action="mark-notifications-read">Mark all as read</button>` : ""}`);
  renderNotificationDot();
  if (unreadIds.length) {
    request("/api/notifications/read",{method:"POST",body:JSON.stringify({ids:unreadIds})})
      .then(() => { state.notificationsUnread = 0; renderNotificationDot(); })
      .catch(() => {});
  }
}

async function markNotificationsRead() {
  try {
    await request("/api/notifications/read",{method:"POST",body:JSON.stringify({})});
    state.notifications = state.notifications.map(item => ({ ...item, read: true }));
    state.notificationsUnread = 0;
    renderNotificationDot();
    document.querySelectorAll(".notification-row").forEach(row => { row.classList.remove("unread"); row.querySelector(".unread-pip")?.remove(); });
    document.querySelector('[data-action="mark-notifications-read"]')?.remove();
  } catch (error) { toast(error.message); }
}

function openNotificationDeepLink(node) {
  const type = node.dataset.type;
  const ref = node.dataset.ref;
  if (type === "message" && ref) {
    closeModal();
    state.activeConversation = ref;
    switchTab("messages");
    return;
  }
  if (type === "connection" || type === "connection_accepted") {
    closeModal();
    state.exploreMode = "people";
    switchTab("explore");
    return;
  }
  if (type === "inspection") { closeModal(); inspectionsSheet(); return; }
  if (type === "booking" || type === "payment") { closeModal(); state.settingsView = false; switchTab("profile"); return; }
  closeModal();
}

function renderAll() {
  renderHome();
  renderExplore();
  renderMessages();
  renderProfile();
  renderAdminVisibility();
  switchTab(state.activeTab, false);
}

/* Admin tab is only rendered when the SERVER says this account is a core
   admin (state.user.isCoreAdmin comes from the bootstrap payload). This is
   UI convenience, not authorization — every admin API call is re-verified
   server-side. */
function renderAdminVisibility() {
  const isAdmin = Boolean(state.user && state.user.isCoreAdmin);
  $$(".admin-only").forEach(node => node.classList.toggle("hidden", !isAdmin));
  if (!isAdmin && state.activeTab === "admin") state.activeTab = "home";
}

function switchTab(tab, render = true) {
  if (tab !== "profile") state.settingsView = false;
  state.activeTab = tab;
  $$(".tab").forEach(node => node.classList.toggle("active", node.id === `tab-${tab}`));
  $$("[data-tab]").forEach(node => node.classList.toggle("active", node.dataset.tab === tab));
  if (render) {
    if (tab === "messages") renderMessages();
    if (tab === "explore") renderExplore();
    if (tab === "profile") renderProfile();
    if (tab === "home") renderHome();
    if (tab === "admin") renderAdmin();
  }
  window.scrollTo({top:0,behavior:"smooth"});
}

function proximityChip(listing) {
  const p = listing.proximity;
  if (!p || !p.distanceText || p.distanceText === "0 m") return `<span class="proximity-chip proximity-unknown" title="The host has not added exact coordinates yet">&#8982; Distance unknown &mdash; check the map or ask the host</span>`;
  return `<span class="proximity-chip" title="Distance and travel time to ${esc(p.university)}">&#8982; ${esc(p.university.replace(/ University$|, [A-Za-z ]+$/, ""))} &middot; ${esc(p.distanceText)}${p.etaText ? ` &middot; ${esc(p.etaText)}` : ""}</span>`;
}

function listingCard(listing, landlordMode = false) {
  const photo = listing.photos?.[0];
  const mine = state.user && listing.ownerId === state.user.id;
  return `<article class="listing-card" role="link" tabindex="0" data-action="${landlordMode ? "edit-listing" : "view-listing"}" data-id="${listing.id}" aria-label="Open ${esc(listing.title)}">
    <div class="listing-image ${esc(listing.accent || "emerald")}">
      ${photo ? `<img src="${photo}" alt="${esc(listing.title)}">` : ""}
      <div class="building"></div>
      <span class="verify-tag">${icon("verified")} ${listing.verified ? "Verified" : "Under review"}</span>
      ${!mine && !landlordMode && listing.full ? `<span class="status-tag quiet-tag">Fully booked</span>` : ""}
      ${mine ? `<span class="status-tag">Your listing</span>`
        : landlordMode
          ? `<span class="status-tag">${esc(listing.status)}</span>`
          : `<button class="save-button ${listing.saved ? "saved" : ""}" data-action="save-listing" data-id="${listing.id}" aria-label="Save property">${icon("heart")}</button>`}
    </div>
    <div class="listing-info">
      <div class="listing-title-row"><h3>${esc(listing.title)}</h3></div>
      <div class="listing-location">${esc(listing.area)} &middot; ${esc(listing.university)}</div>
      ${proximityChip(listing)}
      <div class="listing-meta"><span>${listing.bedrooms} bed</span><span>${listing.bathrooms} bath</span><span>${esc(listing.type)}</span></div>
      <div class="listing-foot">
        <div class="listing-price">${money(listing.price)}<small>per academic year</small></div>
        <span class="listing-open" aria-hidden="true">&rarr;</span>
      </div>
    </div>
  </article>`;
}

function roommateCard(person) {
  return `<article class="roommate-card glass">
    <button class="roommate-avatar" data-action="open-user-profile" data-id="${person.id}" aria-label="Open profile">${avatarHtml(person.name, person.avatarUrl)}</button>
    <div class="roommate-copy">
      <div><h3>${esc(person.name)}</h3><span>${person.score ? `${person.score}% match` : "Add your preferences for a match score"}</span></div>
      <p>${person.bio ? esc(person.bio) : "This student has not written an about-me yet."}</p>
      <div class="amenities">${(person.habits || []).slice(0,3).map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("")}<span class="amenity">${esc(person.university || "University")}</span></div>
    </div>
    <div class="roommate-actions"><button class="button subtle" data-action="view-roommate" data-id="${person.id}">Profile</button><button class="button primary" data-action="connect-roommate" data-id="${person.id}">Message</button></div>
  </article>`;
}

function homeActivity() {
  const rows = [];
  const myInspections = (state.inspections || []).filter(item => item.tenantId === state.user.id);
  const next = myInspections[myInspections.length - 1];
  if (next) {
    const listing = state.listings.find(item => item.id === next.listingId);
    rows.push({ icon: "calendar", b: next.status === "pending" ? "Upcoming inspection" : "Inspection request", s: `${listing?.title || "House inspection"} · ${next.preferredDate || "Date pending"} · ${next.timeWindow}`, action: `<button class="link-button" data-action="open-inspections">View details</button>` });
  }
  const saved = state.listings.filter(item => item.saved).length;
  if (saved) {
    rows.push({ icon: "heart", b: "Continue your search", s: `${saved} saved ${saved === 1 ? "home" : "homes"} in your shortlist`, action: `<button class="link-button" data-tab="explore">Open shortlist</button>` });
  }
  const myBookings = (state.bookings || []).filter(item => item.status !== "cancelled" && !state.ownListings.some(l => l.id === item.listingId));
  if (myBookings.length) {
    const booking = myBookings[myBookings.length - 1];
    const listing = state.listings.find(item => item.id === booking.listingId);
    rows.push({ icon: "home", b: "Your booking", s: `${listing?.title || "Offkay home"} · ${booking.status}`, action: `<button class="link-button" data-tab="profile">View details</button>` });
  }
  if (!rows.length) return "";
  return `<section class="home-activity glass">${rows.slice(0,2).map(row => `<div class="home-activity-row"><span class="metric-icon">${icon(row.icon)}</span><div class="home-activity-text"><b>${row.b}</b><span>${esc(row.s)}</span></div>${row.action}</div>`).join("")}</section>`;
}

function tenantHome() {
  const universityListings = state.listings.filter(item => item.university === state.user.university);
  const visible = (universityListings.length ? universityListings : state.listings).slice(0,3);
  return `
    <div class="home-main">
    <div class="hero-panel">
      <div class="hero-copy">
        <span class="eyebrow"><i class="live-dot"></i> ${esc(state.user.university)}</span>
        <h1>Good ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}, ${esc(firstName(state.user.name))}.</h1>
        <p>Find a home, connect with a roommate, book it all here.</p>
        <div class="hero-actions"><button class="button primary" data-tab="explore">Explore homes &rarr;</button><button class="button subtle" data-action="open-matches">Find a roommate</button></div>
      </div>
      <div class="hero-visual"><div class="mini-property"><div class="mini-building"></div></div></div>
    </div>
    ${homeActivity()}
    <div class="home-recommended">
    <div class="section-head"><div><h2>Recommended near you</h2><p>Verified homes around your university and budget.</p></div><button class="link-button" data-tab="explore">View everything &rarr;</button></div>
    ${visible.length ? `<div class="card-row-fade"><div class="listing-grid home-carousel">${visible.map(item => listingCard(item)).join("")}</div></div>` : emptyState("No local homes yet","Try another university from the Explore tab.")}
    </div>
    <section class="home-roommate glass">
      <div><b>Find your roommate</b><span>Living is easier with the right person.</span></div>
      <button class="button subtle" data-action="open-matches">Find a match</button>
    </section>
    </div>`;
}

function landlordHome() {
  const mine = state.ownListings;
  const myBookings = state.bookings.filter(item => item.ownerId === state.user.id);
  const revenue = myBookings.filter(item => item.status === "paid").reduce((sum,item)=>sum+item.amount,0);
  return `
    <div class="page-head"><div><span class="eyebrow">Property dashboard</span><h1>Welcome back, ${esc(firstName(state.user.name))}.</h1><p>Manage listings, enquiries, and tenant bookings from one place.</p></div><div class="page-actions"><button class="button primary" data-action="new-listing">${icon("plus")} Add property</button></div></div>
    <div class="metrics">
      <div class="metric glass"><div class="metric-top"><span>Active properties</span><span class="metric-icon">${icon("home")}</span></div><strong>${mine.filter(item=>item.status==="active").length}</strong><small>${mine.filter(item=>!item.verified).length} awaiting verification</small></div>
      <div class="metric glass"><div class="metric-top"><span>Total enquiries</span><span class="metric-icon">${icon("messages")}</span></div><strong>${state.conversations.length}</strong><small>Students who have contacted you</small></div>
      <div class="metric glass"><div class="metric-top"><span>Confirmed revenue</span><span class="metric-icon">${icon("lock")}</span></div><strong>${money(revenue)}</strong><small>Platform fee currently set to 0%</small></div>
    </div>
    <div class="section-head"><div><h2>Your properties</h2><p>Listings and their current publishing status.</p></div><button class="link-button" data-tab="explore">Manage all &rarr;</button></div>
    ${propertyTable(mine)}`;
}

function renderHome() {
  $("#tab-home").innerHTML = inHostView() ? landlordHome() : tenantHome();
}

function propertyTable(items) {
  if (!items.length) return emptyState("No properties yet","Add your first property to start receiving student enquiries.",`<button class="button primary" data-action="new-listing">Add a property</button>`);
  return `<div class="property-table glass">
    <div class="property-row header"><span>Property</span><span>Annual rent</span><span>Type</span><span>Status</span><span></span></div>
    ${items.map(item=>`<div class="property-row">
      <div class="property-name"><span class="property-thumb"></span><span><b>${esc(item.title)}</b><span>${esc(item.area)}</span></span></div>
      <b>${money(item.price)}</b><span>${esc(item.type)}</span>
      <span class="table-status ${item.status==="active"?"":"pending"}">${item.status==="active"?(item.verified?"Published":"Under review"):"Hidden"}</span>
      <span class="property-actions"><button class="icon-more" data-action="view-listing" data-id="${item.id}" aria-label="Open property">&rarr;</button><button class="icon-more" data-action="edit-listing" data-id="${item.id}" aria-label="Edit property">&#9998;</button><button class="icon-more danger" data-action="confirm-delete-listing" data-id="${item.id}" aria-label="Delete property">&times;</button></span>
    </div>`).join("")}
  </div>`;
}

function filteredListings() {
  const filters = state.filters.homes;
  const query = filters.query.toLowerCase();
  return state.listings.filter(item => {
    const text = `${item.title} ${item.area} ${item.university}`.toLowerCase();
    return (!query || text.includes(query))
      && (!filters.university || item.university === filters.university)
      && (filters.type === "All" || item.type === filters.type)
      && (!filters.maxPrice || item.price <= Number(filters.maxPrice))
      && (!filters.bedrooms || item.bedrooms >= Number(filters.bedrooms))
      && (!filters.verified || item.verified);
  });
}

function filteredRoommates() {
  const filters = state.filters.roommates;
  const query = filters.query.toLowerCase();
  return state.roommateCandidates.filter(person => {
    const text = `${person.name} ${person.university} ${person.bio || ""} ${(person.habits || []).join(" ")}`.toLowerCase();
    return (!query || text.includes(query))
      && (!filters.university || person.university === filters.university)
      && (!filters.maxBudget || Number(person.budget || 0) <= Number(filters.maxBudget))
      && (!filters.habit || (person.habits || []).includes(filters.habit))
      && (!filters.verified || person.verified);
  });
}

function peopleActiveFilters() {
  const f = state.filters.people;
  return Boolean(f.query.trim() || f.university || f.connected);
}
function homeActiveFilters() {
  const f = state.filters.homes;
  return Boolean(f.university || f.maxPrice || f.bedrooms || f.verified);
}
function roommateActiveFilters() {
  const f = state.filters.roommates;
  return Boolean(f.university || f.maxBudget || f.habit || f.verified);
}
function homeExtraFilterCount() {
  const f = state.filters.homes;
  return [f.university, f.maxPrice, f.bedrooms, f.verified ? "1" : ""].filter(Boolean).length;
}
function openAdvancedFilters() {
  const f = state.filters.homes;
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Filters</span><h2>Narrow your search</h2><p>Only applied to Homes browsing.</p></div><button class="close-button">&times;</button></div>
    <div class="form-stack">
      <label>Keyword<input data-filter="home-query" value="${esc(f.query)}" placeholder="Area, house name..."></label>
      <label class="check-filter"><input type="checkbox" data-filter="home-verified" ${f.verified?"checked":""}><span>Verified only</span></label>
      <div class="sheet-actions">
        <button class="button subtle" data-action="reset-home-filters-sheet">Clear</button>
        <button class="button primary" data-action="apply-advanced-filters">Show results</button>
      </div>
    </div>`);
}
async function loadPeople() {
  if (state.people) return;
  try { const data = await request("/api/people"); state.people = data.people || []; } catch { state.people = state.people || []; }
}
const EXPLORE_MODES = ["homes","map","roommates","people"];
async function switchExploreMode(mode) {
  if (!EXPLORE_MODES.includes(mode)) return;
  state.exploreMode = mode;
  if (mode === "people") await loadPeople();
  renderExplore();
}

const HOME_TYPES = ["All","Studio","Shared","En-suite","Self-contained","Apartment"];
const HABIT_OPTIONS = ["Very tidy","Night owl","Early bird","Quiet home","Social","Non-smoker","Cooks often","Pet friendly"];
function selectFilter(name, current, options) {
  return `<select class="filter-pill${current ? " set" : ""}" data-filter="${name}" aria-label="${name.replace(/-/g," ")}">${options}</select>`;
}
function renderExplore() {
  const items = filteredListings();
  const roommates = filteredRoommates();
  const hosting = inHostView();
  const browsingRoommates = state.exploreMode === "roommates";
  const browsingPeople = state.exploreMode === "people";
  const homeFilters = state.filters.homes;
  const roommateFilters = state.filters.roommates;
  const habitOptions = HABIT_OPTIONS;
  $("#tab-explore").innerHTML = `<div class="explore-main">
    ${hosting ? `<div class="page-head"><div><span class="eyebrow">Host tools</span><h1>Manage your places.</h1><p>Review your properties and incoming inspection requests.</p></div><div class="page-actions"><button class="button subtle" data-action="open-inspections">${icon("calendar")} Inspections</button><button class="button primary" data-action="new-listing">${icon("plus")} Add a house</button></div></div>` : `
    <header class="explore-hero">
      <span class="explore-eyebrow">Explore Offkay</span>
      <h1>Find a home, then find your people.</h1>
      <p>Search verified homes and compatible roommates.</p>
      <label class="explore-search">
        <span class="explore-search-icon" aria-hidden="true"><svg class="off-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>
        <input class="explore-input" data-filter="home-query" value="${esc(homeFilters.query)}" placeholder="Search homes, areas, or universities..." aria-label="Search homes, areas, or universities">
        <button class="explore-search-action" type="button" data-action="open-inspections">${icon("calendar")}<span>Inspections</span></button>
      </label>
    </header>
    <div class="liquid-segment" aria-label="Explore view"><button class="${state.exploreMode==="homes"?"active":""}" data-action="explore-mode" data-mode="homes">Homes</button><button class="${state.exploreMode==="map"?"active":""}" data-action="explore-mode" data-mode="map">Map</button><button class="${browsingRoommates?"active":""}" data-action="explore-mode" data-mode="roommates">Roommates</button><button class="${browsingPeople?"active":""}" data-action="explore-mode" data-mode="people">People</button></div>`}
    ${hosting ? `<div class="section-head"><div><h2>Your properties</h2><p>Published places and verification status. Hide or delete test listings when you are done.</p></div></div>${propertyTable(state.ownListings)}` : browsingPeople ? peopleSection() : browsingRoommates ? `
      <div class="results-head mode-head"><div><b>Find a roommate</b><small>Match by campus, budget, and lifestyle.</small></div></div>
      <div class="explore-filter-row">
        ${selectFilter("roommate-university", roommateFilters.university, `<option value="">All universities</option>${state.universities.map(name=>`<option value="${esc(name)}" ${roommateFilters.university===name?"selected":""}>${esc(name)}</option>`).join("")}`)}
        ${selectFilter("roommate-budget", roommateFilters.maxBudget, `<option value="">Any budget</option><option value="300000" ${roommateFilters.maxBudget==="300000"?"selected":""}>Up to &#8358;300k</option><option value="500000" ${roommateFilters.maxBudget==="500000"?"selected":""}>Up to &#8358;500k</option><option value="750000" ${roommateFilters.maxBudget==="750000"?"selected":""}>Up to &#8358;750k</option>`)}
        ${selectFilter("roommate-habit", roommateFilters.habit, `<option value="">Any lifestyle</option>${habitOptions.map(habit=>`<option value="${esc(habit)}" ${roommateFilters.habit===habit?"selected":""}>${esc(habit)}</option>`).join("")}`)}
        <button class="filter-pill pill-toggle${roommateFilters.verified?" set":""}" data-action="toggle-roommate-verified" aria-pressed="${roommateFilters.verified}">${icon("verified")} Verified</button>
      </div>
      <div class="results-head${roommateActiveFilters()?" has-active":""}"><div><b>${roommates.length} ${roommates.length===1?"roommate":"roommates"}</b><small>matched to your campus and budget</small></div>${roommateActiveFilters()?`<button class="link-button" data-action="reset-roommate-filters">Clear</button>`:""}</div>
      <div class="roommate-grid">${roommates.map(roommateCard).join("") || emptyState("No roommates match yet","Try widening a filter or update your own profile in Settings.")}</div>` : `
      <div class="explore-filter-row">
        ${selectFilter("home-university", homeFilters.university, `<option value="">All universities</option>${state.universities.map(name=>`<option value="${esc(name)}" ${homeFilters.university===name?"selected":""}>${esc(name)}</option>`).join("")}`)}
        ${selectFilter("home-price", homeFilters.maxPrice, `<option value="">Any budget</option><option value="300000" ${homeFilters.maxPrice==="300000"?"selected":""}>Under &#8358;300k</option><option value="500000" ${homeFilters.maxPrice==="500000"?"selected":""}>Under &#8358;500k</option><option value="750000" ${homeFilters.maxPrice==="750000"?"selected":""}>Under &#8358;750k</option>`)}
        ${selectFilter("home-bedrooms", homeFilters.bedrooms, `<option value="">Any size</option><option value="1" ${homeFilters.bedrooms==="1"?"selected":""}>1+ bedroom</option><option value="2" ${homeFilters.bedrooms==="2"?"selected":""}>2+ bedrooms</option><option value="3" ${homeFilters.bedrooms==="3"?"selected":""}>3+ bedrooms</option>`)}
        <button class="filter-pill pill-toggle${homeFilters.verified?" set":""}" data-action="toggle-home-verified" aria-pressed="${homeFilters.verified}">${icon("verified")} Verified</button>
        <button class="filter-pill" data-action="open-advanced-filters">Filters${homeExtraFilterCount() ? ` <b class="filter-pill-count">${homeExtraFilterCount()}</b>` : ""}</button>
      </div>
      <div class="filter-chips">${HOME_TYPES.map(type=>`<button class="chip ${homeFilters.type===type?"active":""}" data-action="filter-type" data-type="${type}">${type}</button>`).join("")}</div>
      <div class="results-head${homeFilters.query||homeActiveFilters()?" has-active":""}"><div><b>${items.length} ${items.length===1?"home":"homes"}</b><small>verified places matching your search</small></div>${homeFilters.query||homeActiveFilters()?`<button class="link-button" data-action="reset-home-filters">Clear</button>`:""}</div>
      ${state.exploreMode==="map" ? mapCanvas(items) : `<div class="explore-list">${items.map(item=>listingCard(item)).join("") || emptyState("Nothing matches those filters","Try clearing a filter or selecting another university.")}</div>`}`}
  </div>`;
}

function listingCoords(item) {
  const lat = Number(item.latitude), lng = Number(item.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) return {lat,lng};
  const altLat = Number(item.approxLatitude), altLng = Number(item.approxLongitude);
  return Number.isFinite(altLat) && Number.isFinite(altLng) && (altLat || altLng) ? {lat:altLat,lng:altLng} : null;
}

const TILE_SIZE = 256;
function lngToTileX(lng, z) { return (lng + 180) / 360 * (2 ** z); }
function latToTileY(lat, z) { const rad = lat * Math.PI / 180; return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * (2 ** z); }

/* A static tile view centered on the listing: one 3x2 grid of real OSM tiles
   (tile.openstreetmap.org permits light app use) with the pin placed at the
   exact fractional tile position. This replaces the openstreetmap.org/export
   embed iframe, which began rejecting production hotlinks (blank frames). */
function osmEmbed(item, height) {
  const coords = listingCoords(item);
  if (!coords) return "";
  const {lat,lng} = coords;
  const z = 16;
  const cols = 3, rows = 2;
  const x = lngToTileX(lng, z), y = latToTileY(lat, z);
  const xTile = Math.floor(x), yTile = Math.floor(y);
  const tiles = [];
  for (let dy = -1; dy <= rows - 2; dy++) {
    for (let dx = -1; dx <= cols - 2; dx++) {
      tiles.push(`<div class="map-tile" style="background-image:url('https://tile.openstreetmap.org/${z}/${xTile+dx}/${yTile+dy}.png')"></div>`);
    }
  }
  const pinLeft = ((x - (xTile - 1)) / cols) * 100;
  const pinTop = ((y - (yTile - 1)) / rows) * 100;
  return `<div class="osm-embed map-static" style="height:${height}px" title="Map of ${esc(item.title)}">
    <div class="map-tile-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr)">${tiles.join("")}</div>
    <span class="map-pin" style="left:${pinLeft}%;top:${pinTop}%"></span>
    <span class="map-attribution">© OpenStreetMap contributors</span>
  </div>`;
}

function mapCanvas(items) {
  const withCoords = items.filter(item => listingCoords(item));
  if (!withCoords.length) {
    return emptyState("Map coming for these homes","Landlords haven't added map coordinates yet. Use the Homes tab to browse, or open a listing and tap View on map.");
  }
  return `<div class="map-stack">${withCoords.map(item => `
    <div class="map-card glass">
      ${osmEmbed(item, 240) || `<div class="map-placeholder">No map pin yet</div>`}
      <div class="map-card-info">
        <div><b>${esc(item.title)}</b><span>${esc(item.area)} · ${money(item.price)}</span></div>
        <button class="button subtle small" data-action="view-listing" data-id="${item.id}">Open home</button>
      </div>
    </div>`).join("")}</div>`;
}

function visibleConversations() {
  const query = String(state.conversationQuery || "").trim().toLowerCase();
  if (!query) return state.conversations;
  return state.conversations.filter(item => `${item.other?.name || ""} ${item.listingTitle || ""} ${item.lastMessage?.text || ""}`.toLowerCase().includes(query));
}

function conversationRow(conversation) {
  const active = state.activeConversation === conversation.id;
  return `<button class="conversation ${active?"active":""}" data-action="open-conversation" data-id="${conversation.id}">
    ${avatarHtml(conversation.other?.name, conversation.other?.avatarUrl)}
    <span class="conversation-text"><b>${esc(conversation.other?.name || "Offkay user")}</b><span>${esc(conversation.lastMessage?.text || "Start the conversation")}</span></span>
    <time>${conversation.lastMessage ? time(conversation.lastMessage.createdAt) : ""}${conversation.unread ? `<i class="unread-dot">${conversation.unread}</i>` : ""}</time>
  </button>`;
}

function connectButton(person, normal = false) {
  const link = person.connection || { state: "none" };
  const size = normal ? "" : " small";
  if (link.state === "connected") return `<button class="button light${size}" disabled>&#10003; Connected</button>`;
  if (link.state === "outgoing") return `<button class="button subtle${size}" data-action="decline-connect" data-id="${link.connectionId || person.id}" title="Withdraw request">Request sent</button>`;
  if (link.state === "incoming") return `<button class="button primary${size}" data-action="accept-connect" data-id="${link.connectionId || person.id}">Accept request</button>`;
  return `<button class="button subtle${size}" data-action="send-connect" data-id="${person.id}">Connect</button>`;
}

function personRow(person) {
  return `<div class="person-row">
    <button class="person-main" data-action="open-user-profile" data-id="${person.id}">
      ${avatarHtml(person.name, person.avatarUrl)}
      <span class="conversation-text"><b>${esc(person.name)}</b><span>${esc(person.university || "Offkay")}${person.bio ? ` · ${esc(person.bio.slice(0,60))}${person.bio.length>60?"…":""}` : ""}</span></span>
    </button>
    <button class="button subtle small" data-action="start-chat" data-id="${person.id}">Message</button>
    ${connectButton(person)}
  </div>`;
}

function peopleSection() {
  const people = state.people || [];
  const filters = state.filters.people;
  const query = filters.query.trim().toLowerCase();
  const visible = people.filter(person => {
    if (filters.university && person.university !== filters.university) return false;
    if (filters.connected && person.connection?.state !== "connected") return false;
    if (query && !`${person.name} ${person.university || ""} ${person.bio || ""} ${(person.habits || []).join(" ")}`.toLowerCase().includes(query)) return false;
    return true;
  });
  return `
    <div class="explore-filter-row">
      <input class="filter-pill filter-pill-input" data-filter="people-query" value="${esc(filters.query)}" placeholder="Search people..." aria-label="Search people">
      ${selectFilter("people-university", filters.university, `<option value="">All universities</option>${state.universities.map(name=>`<option value="${esc(name)}" ${filters.university===name?"selected":""}>${esc(name)}</option>`).join("")}`)}
      <button class="filter-pill pill-toggle${filters.connected?" set":""}" data-action="toggle-people-connected" aria-pressed="${filters.connected}">Connections</button>
    </div>
    <div class="results-head${peopleActiveFilters()?" has-active":""}"><div><b>${visible.length} ${visible.length===1?"person":"people"}</b><small>open a profile to see bio, lifestyle, and connection state</small></div>${peopleActiveFilters()?`<button class="link-button" data-action="reset-people-filters">Clear</button>`:""}</div>
    <div class="people-directory">${visible.map(personCard).join("") || emptyState("No one matches yet","Try clearing a filter — new members appear here as they join Offkay.")}</div>`;
}

function personCard(person) {
  return `<article class="roommate-card glass person-card">
    <button class="roommate-avatar" data-action="open-user-profile" data-id="${person.id}" aria-label="Open profile">${avatarHtml(person.name, person.avatarUrl)}</button>
    <div class="roommate-copy">
      <div><h3><a href="#" data-action="open-user-profile" data-id="${person.id}" class="person-name-link">${esc(person.name)}</a></h3><span>${person.score ? `${person.score}% match` : (person.connection?.state === "connected" ? "Connected" : esc(person.university || ""))}</span></div>
      <p>${esc(person.bio || "This member has not added a bio yet.")}</p>
      <div class="amenities">${(person.habits || []).slice(0,3).map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("")}${person.verified?`<span class="amenity verify-amenity">&#10003; Verified</span>`:""}${person.university?`<span class="amenity">${esc(person.university)}</span>`:""}</div>
    </div>
    <div class="roommate-actions">
      ${connectButton(person, true)}
      <button class="button subtle" data-action="start-chat" data-id="${person.id}">Message</button>
    </div>
  </article>`;
}

async function openUserProfile(id) {
  closeModal();
  try {
    const data = await request(`/api/users/${encodeURIComponent(id)}`);
    const person = data.user;
    if (!person) throw new Error("Profile not found");
    state.openProfileId = person.id;
    modal(`
      <div class="modal-head"><div><span class="eyebrow">${person.verified ? "&#10003; Verified member" : "Offkay member"}${person.score ? ` · ${person.score}% match` : ""}</span><h2>${esc(person.name)}</h2><p>${esc(person.university || "Offkay")}${person.hosting ? " · Host" : " · Student"}</p></div><button class="close-button">&times;</button></div>
      <div class="public-profile">
        <div class="profile-hero-mini">
          ${avatarHtml(person.name, person.avatarUrl, "large")}
          <div class="profile-hero-facts">
            ${person.connection?.state === "connected" ? `<span class="verified-line">&#10003; Connected</span>` : ""}
            <small>Member since ${person.memberSince ? new Date(person.memberSince).toLocaleDateString("en-NG",{month:"long",year:"numeric"}) : "recently"}</small>
          </div>
        </div>
        ${person.score || person.budget || person.hosting ? `<div class="profile-facts">
          ${person.score ? `<div class="fact"><b>${person.score}%</b><span>match</span></div>` : ""}
          ${person.budget ? `<div class="fact"><b>${money(person.budget)}</b><span>budget ceiling</span></div>` : ""}
          <div class="fact"><b>${person.hosting ? "Host" : "Student"}</b><span>on Offkay as</span></div>
        </div>` : ""}
        <h3>About</h3>
        <p>${esc(person.bio || "This member has not written an about section yet.")}</p>
        ${person.habits?.length ? `<h3>Lifestyle</h3><div class="amenities">${person.habits.map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("")}</div>` : ""}
        ${person.budget ? `<h3>Budget</h3><div class="cost-row"><span>Annual budget ceiling</span><b>${money(person.budget)}</b></div>` : ""}
        <div class="detail-actions">
          ${connectButton(person, true)}
          <button class="button subtle" data-action="start-chat" data-id="${person.id}">Message</button>
        </div>
        <p class="share-hint">Only profile details this member chose to share are shown. Contact details stay private until they reply.</p>
      </div>`);
  } catch (error) { toast(error.message); }
}

async function sendConnect(id, button) {
  if (button) setLoading(button, true, "Sending...");
  try {
    await request("/api/connections",{method:"POST",body:JSON.stringify({userId:id})});
    await refreshData(false);
    toast("Connection request sent");
    if (state.openProfileId === id) openUserProfile(id);
    else renderExplore();
  } catch (error) { toast(error.message); }
  finally { if (button) setLoading(button, false); }
}

async function respondConnect(connectionId, accept, button) {
  if (button) setLoading(button, true, accept ? "Accepting..." : "Removing...");
  try {
    await request(`/api/connections/${encodeURIComponent(connectionId)}/${accept ? "accept" : "decline"}`,{method:"POST"});
    await refreshData(false);
    toast(accept ? "You are now connected" : "Request removed");
    if (state.openProfileId) openUserProfile(state.openProfileId);
    else renderExplore();
  } catch (error) { toast(error.message); }
  finally { if (button) setLoading(button, false); }
}

function renderMessages() {
  const current = state.conversations.find(item=>item.id===state.activeConversation);
  const query = String(state.discovery || "").trim().toLowerCase();
  const directory = (state.people || []).filter(person => {
    if (!query) return true;
    const haystack = `${person.name} ${person.university || ""} ${(person.habits || []).join(" ")}`.toLowerCase();
    return haystack.includes(query);
  });
  $("#tab-messages").innerHTML = `
    <div class="message-shell glass ${current?"chat-open":""}">
      <aside class="conversation-list">
        <h2>Messages</h2>
        <input class="conversation-search" id="conversationSearch" placeholder="Search conversations..." value="${esc(state.conversationQuery || "")}">
        <div id="conversationRows">${visibleConversations().map(conversationRow).join("") || `<div class="no-conv-hint">${(state.conversationQuery || "").trim() ? "No conversation matches that search." : "No conversations yet. Open someone’s profile or use Find people below, then tap Message."}</div>`}</div>
        <div class="discover-block">
          <h3>Find people</h3>
          <input class="conversation-search" id="peopleSearch" placeholder="Search people by name, school, or lifestyle..." value="${esc(state.discovery || "")}">
          <div id="peopleRows">${directory.slice(0,12).map(personRow).join("") || `<div class="no-conv-hint">No one matches yet. Try a different name or school.</div>`}</div>
        </div>
      </aside>
      ${current ? chatMarkup(current) : `<div class="no-chat"><div><div class="empty-icon">${icon("messages")}</div><b>Select a conversation</b><p>Your messages appear here and stay in your account — including photos, videos, and voice notes.</p></div></div>`}
    </div>`;
  const peopleSearch = $("#peopleSearch");
  if (peopleSearch) peopleSearch.addEventListener("input", event => {
    state.discovery = event.target.value;
    const q = String(state.discovery).trim().toLowerCase();
    const filtered = (state.people || []).filter(person => {
      if (!q) return true;
      return `${person.name} ${person.university || ""} ${(person.habits || []).join(" ")}`.toLowerCase().includes(q);
    });
    $("#peopleRows").innerHTML = filtered.slice(0,12).map(personRow).join("") || `<div class="no-conv-hint">No one matches yet.</div>`;
  });
  if (current) loadMessages(current.id);
  else setChatPolling(null);
}

function chatMarkup(conversation) {
  return `<section class="chat">
    <header class="chat-head"><button class="icon-more mobile-chat-back" data-action="back-to-conversations">&larr;</button><button class="chat-head-user" data-action="open-user-profile" data-id="${conversation.other?.id || ""}">${avatarHtml(conversation.other?.name, conversation.other?.avatarUrl)}<span><b>${esc(conversation.other?.name || "Offkay user")}</b><small>${conversation.other?.verified?"&#10003; Verified user":"Offkay member"}</small></span></button>${conversation.listingTitle ? `<span class="chat-listing-tag">${esc(conversation.listingTitle)}</span>` : ""}</header>
    <div class="chat-messages" id="chatMessages"><div class="no-chat">Loading messages...</div></div>
    <form class="chat-compose" id="messageForm">
      <div class="chat-attachments" id="chatAttachments" hidden></div>
      <div class="chat-compose-row">
        <button type="button" class="compose-icon" data-action="pick-attachment" aria-label="Attach a photo or video">${icon("plus")}</button>
        <button type="button" class="compose-icon" data-action="record-voice" aria-label="Record a voice note">${icon("mic")}</button>
        <input name="text" autocomplete="off" placeholder="Write a message...">
        <button class="send-button" type="submit" aria-label="Send">&uarr;</button>
      </div>
      <input type="file" id="chatFileInput" accept="image/*,video/mp4,video/webm" multiple hidden>
    </form>
    <div class="voice-recorder" id="voiceRecorder" hidden>
      <span class="rec-dot"></span><span id="recorderTime">0:00</span>
      <span class="rec-hint">Recording voice note…</span>
      <button type="button" class="button subtle small" data-action="cancel-recording">Cancel</button>
      <button type="button" class="button primary small" data-action="stop-recording">Send</button>
    </div>
  </section>`;
}

let chatPoll = null;
function setChatPolling(conversationId) {
  clearInterval(chatPoll);
  chatPoll = null;
  if (!conversationId || !state.user) return;
  chatPoll = setInterval(async () => {
    if (!state.user || state.activeConversation !== conversationId) return;
    try {
      const data = await request(`/api/conversations/${conversationId}/messages`);
      if (state.activeConversation !== conversationId) return;
      const known = state.messages.map(message=>message.id).join(",");
      const incoming = data.messages.map(message=>message.id).join(",");
      state.messages = data.messages;
      if (known !== incoming) renderMessageList(data.messages);
      // Live updates while the chat is open: preview, list order, badges.
      const fresh = state.conversations.find(item=>item.id===conversationId);
      if (fresh && data.conversation) Object.assign(fresh, data.conversation);
      const rows = $("#conversationRows");
      if (rows && fresh) {
        rows.innerHTML = visibleConversations().map(conversationRow).join("");
      }
      request("/api/badges").then(b => {
        state.unreadMessages = b.messages;
        state.notificationsUnread = b.notifications;
        if (b.adminPending !== undefined) state.adminPending = b.adminPending;
        renderNotificationDot();
      }).catch(() => {});
    } catch { /* keep polling silently */ }
  }, 4000);
}

function renderMessageList(messages) {
  const box = $("#chatMessages");
  if (!box) return;
  const stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const distanceFromBottom = box.scrollHeight - box.scrollTop;
  box.innerHTML = messages.map(message=>{
    const mine = message.senderId===state.user.id;
    const media = (message.attachments||[]).map(a=>attachmentMarkup(a, mine)).join("");
    // Image-only messages render without bubble chrome (no green frame).
    const mediaOnly = !message.text && (message.attachments||[]).some(a=>String(a.mime||"").startsWith("image/"));
    return `<div class="bubble ${mine?"mine":""}${mediaOnly?" media-only":""}">${media}${message.text ? `<p>${esc(message.text)}</p>` : ""}<time>${time(message.createdAt)}</time></div>`;
  }).join("") || `<div class="no-chat">No messages yet. Say hello.</div>`;
  // innerHTML resets scrollTop, so restore from the distance captured above:
  // anchored to the newest message when following, or frozen on the exact
  // history the user was reading when scrolled up.
  box.scrollTop = stickToBottom ? box.scrollHeight : Math.max(0, box.scrollHeight - distanceFromBottom);
}

async function loadMessages(conversationId) {
  try {
    const data = await request(`/api/conversations/${conversationId}/messages`);
    if (state.activeConversation !== conversationId) return;
    state.messages = data.messages;
    renderMessageList(data.messages);
    setChatPolling(conversationId);
    const fresh = state.conversations.find(item=>item.id===conversationId);
    if (fresh && data.conversation) {
      // Opening the conversation marks it read server-side; adopt the fresh
      // unread count right away so the Messages badge clears on view.
      const wasUnread = Number(fresh.unread) || 0;
      Object.assign(fresh, data.conversation);
      if (wasUnread) {
        state.unreadMessages = Math.max(0, (Number(state.unreadMessages) || unreadTotal()) - wasUnread);
      }
      renderNotificationDot();
      request("/api/badges").then(b => {
        state.unreadMessages = b.messages;
        state.notificationsUnread = b.notifications;
        if (b.adminPending !== undefined) state.adminPending = b.adminPending;
        renderNotificationDot();
      }).catch(() => {});
    }
    const form = $("#messageForm");
    if (form) form.onsubmit = sendMessage;
  } catch (error) { toast(error.message); }
}

let sendingMessage = false;

async function sendMessage(event) {
  event.preventDefault();
  if (sendingMessage) return; // guard against double-taps on the send button
  const input = event.currentTarget.elements.text;
  const text = input.value.trim();
  const attachments = pendingChatAttachments.slice();
  if ((!text && !attachments.length) || !state.activeConversation) return;
  input.value = "";
  pendingChatAttachments = [];
  renderPendingAttachments();
  sendingMessage = true;
  try {
    await request(`/api/conversations/${state.activeConversation}/messages`,{method:"POST",body:JSON.stringify({ text, attachments })});
    const data = await request(`/api/conversations/${state.activeConversation}/messages`);
    state.messages = data.messages;
    renderMessageList(data.messages);
    await refreshData(false);
    renderNotificationDot();
    const rows = $("#conversationRows");
    if (rows) rows.innerHTML = state.conversations.map(conversationRow).join("");
  } catch (error) {
    input.value = text;
    pendingChatAttachments = attachments;
    renderPendingAttachments();
    toast(error.message);
  } finally {
    sendingMessage = false;
  }
}

/* ---- Chat media + voice notes ------------------------------------------- */
let pendingChatAttachments = [];
const CHAT_MEDIA_LIMIT = 650 * 1000; // bytes; leaves headroom in the 2 MB JSON body

function attachmentMarkup(attachment) {
  if (!attachment?.dataUrl) return "";
  const mime = String(attachment.mime || "");
  if (mime.startsWith("image/")) return `<button type="button" class="chat-media chat-image" data-action="open-image-viewer" aria-label="View photo full size"><img src="${attachment.dataUrl}" alt="${esc(attachment.name || "Photo")}" loading="lazy"></button>`;
  if (mime.startsWith("video/")) return `<video class="chat-media" src="${attachment.dataUrl}" controls preload="metadata" playsinline></video>`;
  if (mime.startsWith("audio/")) return `<span class="voice-note"><small>Voice note${attachment.meta && /\d/.test(attachment.meta) ? " \u00b7 " + esc(attachment.meta) : ""}</small><audio src="${attachment.dataUrl}" controls preload="metadata"></audio></span>`;
  return "";
}

/* In-app image viewer: opens the photo over the conversation; nothing navigates
   away. Click anywhere (or Esc / the X) closes it. */
function openImageViewer(dataUrl, alt) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="image-viewer" role="dialog" aria-modal="true" aria-label="Photo preview">
    <button type="button" class="image-viewer-close" data-action="close-image-viewer" aria-label="Close preview">&times;</button>
    <img src="${dataUrl}" alt="${esc(alt || "Photo")}">
  </div>`;
  root.classList.add("open","viewer");
}
function closeImageViewer() {
  const root = $("#modalRoot");
  root.classList.remove("open","viewer");
  root.innerHTML = "";
}

function renderPendingAttachments() {
  const wrap = $("#chatAttachments");
  if (!wrap) return;
  wrap.hidden = !pendingChatAttachments.length;
  wrap.innerHTML = pendingChatAttachments.map((item, index) => {
    const remove = `<button type="button" data-action="remove-attachment" data-id="${index}" aria-label="Remove attachment">&times;</button>`;
    if (item.kind === "audio") return `<span class="pending-chip"><small>Voice note${item.durationLabel ? " \u00b7 " + esc(item.durationLabel) : ""}</small>${remove}</span>`;
    if (item.kind === "video") return `<span class="pending-chip"><video src="${item.dataUrl}" muted></video>${remove}</span>`;
    return `<span class="pending-chip"><img src="${item.dataUrl}" alt="">${remove}</span>`;
  }).join("");
}

function pickAttachment() {
  const input = $("#chatFileInput");
  if (!input) return;
  input.value = "";
  input.click();
}

function probeMediaDuration(file, kind) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => { const d = el.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cannot read media")); };
    el.src = url;
  });
}

// Some Android pickers report an empty file.type - infer it from the extension.
function inferFileType(file) {
  if (file.type) return file.type;
  const ext = String(file.name || "").toLowerCase().match(/\.(jpe?g|png|gif|webp|heic|mp4|webm|mov)$/);
  if (!ext) return "";
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", mp4: "video/mp4", webm: "video/webm", mov: "video/mp4" };
  return map[ext[1]] || "";
}

const CHAT_DATAURL_BUDGET = 1150000; // data-URL chars; ~860 KB binary, under the server cap

// Downscale + re-encode a photo to a JPEG data URL that fits the message budget.
function compressImageToDataUrl(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let best = null;
      for (const dim of [maxDim, 1280, 1024, 800, 640]) {
        const scale = Math.min(1, dim / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((img.width || dim) * scale));
        canvas.height = Math.max(1, Math.round((img.height || dim) * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Image compression is not supported here"));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const q of [0.8, 0.62, 0.45]) {
          const out = canvas.toDataURL("image/jpeg", q);
          if (!best || out.length < best.length) best = out;
          if (out.length <= CHAT_DATAURL_BUDGET) return resolve(out);
        }
      }
      if (best) resolve(best);
      else reject(new Error("We could not read that image"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That image could not be read - try a JPG or PNG")); };
    img.src = url;
  });
}

async function handlePickedFiles(fileList) {
  for (const file of [...fileList]) {
    const fileType = inferFileType(file);
    const isImage = fileType.startsWith("image/");
    const isVideo = fileType.startsWith("video/");
    if (!isImage && !isVideo) { toast("Only photos and short videos can be attached"); continue; }
    if (isVideo && file.size > CHAT_MEDIA_LIMIT) { toast(isVideo ? "Keep videos short — under about 650 KB (roughly 10 seconds)" : "Choose a photo under 650 KB"); continue; }
    if (isVideo) {
      try {
        const duration = await probeMediaDuration(file, "video");
        if (duration > 15) { toast("Videos must be 15 seconds or shorter"); continue; }
      } catch { /* duration unknown — size cap still applies */ }
    }
    try {
      const dataUrl = isImage ? await compressImageToDataUrl(file) : await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("We could not read that file"));
        reader.readAsDataURL(file);
      });
      if (dataUrl.length > CHAT_DATAURL_BUDGET && !isImage) { toast("Keep videos short - under about 650 KB (roughly 10 seconds)"); continue; }
      pendingChatAttachments.push({ kind: isVideo ? "video" : "image", dataUrl, name: file.name || "attachment" });
      renderPendingAttachments();
    } catch (error) { toast(error.message); }
  }
}

let mediaRecorder = null;
let mediaChunks = [];
let mediaStream = null;
let recorderTimer = null;
let recorderSeconds = 0;

function recordingSupported() {
  return Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
}

async function startVoiceRecording() {
  if (!recordingSupported()) { toast("Voice notes need a browser with microphone recording support"); return; }
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    toast(error?.name === "NotAllowedError" ? "Microphone permission was denied. Enable it in your browser settings to send voice notes." : "Could not start recording on this device.");
    return;
  }
  try { mediaRecorder = new MediaRecorder(mediaStream); }
  catch { toast("Recording is not supported in this browser"); cleanupRecording(); return; }
  mediaChunks = [];
  mediaRecorder.ondataavailable = event => { if (event.data && event.data.size) mediaChunks.push(event.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start();
  recorderSeconds = 0;
  document.querySelector(".chat")?.classList.add("is-recording");
  const recorder = $("#voiceRecorder");
  if (recorder) { recorder.hidden = false; const label = $("#recorderTime"); if (label) label.textContent = "0:00"; }
  recorderTimer = setInterval(() => {
    recorderSeconds += 1;
    const label = $("#recorderTime");
    if (label) label.textContent = `${Math.floor(recorderSeconds / 60)}:${String(recorderSeconds % 60).padStart(2, "0")}`;
    if (recorderSeconds >= 60) stopVoiceRecording(true);
  }, 1000);
}

function cleanupRecording() {
  document.querySelector(".chat")?.classList.remove("is-recording");
  clearInterval(recorderTimer);
  recorderTimer = null;
  if (mediaStream) { mediaStream.getTracks().forEach(track => track.stop()); mediaStream = null; }
}

function cancelVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") { mediaRecorder.onstop = null; mediaRecorder.stop(); }
  cleanupRecording();
  const recorder = $("#voiceRecorder");
  if (recorder) recorder.hidden = true;
  mediaChunks = [];
}

function stopVoiceRecording(auto) {
  if (!mediaRecorder || mediaRecorder.state === "inactive") { if (auto) cancelVoiceRecording(); return; }
  mediaRecorder.stop();
}

function onRecordingStopped() {
  cleanupRecording();
  const recorder = $("#voiceRecorder");
  if (recorder) recorder.hidden = true;
  const type = ((mediaRecorder && mediaRecorder.mimeType) || "audio/webm").split(";")[0];
  const blob = new Blob(mediaChunks, { type });
  mediaChunks = [];
  if (blob.size < 1200) { toast("That recording was too short to send"); return; }
  if (blob.size > CHAT_MEDIA_LIMIT) { toast("Voice note too long — keep it under about a minute"); return; }
  const seconds = recorderSeconds;
  const reader = new FileReader();
  reader.onload = () => {
    pendingChatAttachments.push({ kind: "audio", dataUrl: String(reader.result), name: "voice-note", durationLabel: `${seconds}s` });
    renderPendingAttachments();
  };
  reader.readAsDataURL(blob);
}

function changeAvatar() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp";
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageToDataUrl(file, 400);
      const data = await request("/api/profile",{method:"PATCH",body:JSON.stringify({ avatar: dataUrl })});
      state.user = data.user;
      renderProfile();
      enterApp();
      toast("Profile photo updated");
    } catch (error) { toast(error.message); }
  };
  input.click();
}

function renderProfile() {
  if (state.settingsView) return renderSettings();
  const tenant = state.user.role === "tenant";
  const hosting = canHost() && !tenant;
  const savedCount = state.listings.filter(item=>item.saved).length;
  const mine = state.ownListings.length;
  const paid = state.bookings.filter(item=>item.status==="paid").length;
  const hostPaid = state.bookings.filter(item=>item.status==="paid" && state.ownListings.some(listing=>listing.id===item.listingId)).length;
  const hostRequests = (state.inspections||[]).filter(item=>state.ownListings.some(listing=>listing.id===item.listingId)).length;
  const connections = (state.people || []).filter(item => item.connection?.state === "connected").length;
  const habits = ["Very tidy","Night owl","Early bird","Quiet home","Social","Non-smoker","Cooks often","Pet friendly"];
  const chosenHabits = (state.user.habits || []).filter(habit => habits.includes(habit));
  $("#tab-profile").innerHTML = `
    <section class="profile-hero glass">
      <div class="profile-hero-id">
        ${avatarHtml(state.user.name, state.user.avatarUrl, "large")}
        <div class="profile-hero-name">
          <h1>${esc(state.user.name)}</h1>
          <p>${esc(state.user.email)} &middot; ${hosting && !tenant ? "Host" : hosting ? "Host & tenant" : "Tenant"}</p>
          ${verificationBadge(verificationState(), state.verification)}
        </div>
      </div>
      <div class="profile-hero-actions">
        <button class="button subtle" data-action="open-settings">${icon("settings")} Settings</button>
        <button class="button subtle" data-action="change-avatar">${icon("plus")} Change photo</button>
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section-head"><h2>Verification</h2><p>${tenant?"Verified students get more roommate matches and can book faster.":hosting?"Verified hosts appear with a verification badge on every listing.":"Verification confirms your identity for everything you do on Offkay."}</p></div>
      ${verificationPanel(verificationState(), state.verification)}
    </section>

    <section class="profile-section">
      <div class="profile-section-head"><h2>Your activity</h2><p>Live numbers from your Offkay account.</p></div>
      <div class="profile-stats">
        ${tenant
          ? `<div class="profile-stat"><b>${savedCount}</b><span>SAVED HOMES</span></div>
             <div class="profile-stat"><b>${paid}</b><span>CONFIRMED</span></div>
             <div class="profile-stat"><b>${connections}</b><span>CONNECTIONS</span></div>`
          : hosting ? `<div class="profile-stat"><b>${mine}</b><span>PROPERTIES</span></div>
             <div class="profile-stat"><b>${hostPaid}</b><span>CONFIRMED</span></div>
             <div class="profile-stat"><b>${hostRequests}</b><span>TOUR REQUESTS</span></div>` : ""}
      </div>
    </section>

    ${tenant ? `
    <section class="profile-section">
      <div class="profile-section-head"><h2>Roommate preferences</h2><p>What matching uses to pair you with compatible people.</p></div>
      <div class="pref-card glass">
        <div class="pref-line"><span>University</span><b>${esc(state.user.university || "Not set")}</b></div>
        <div class="pref-line"><span>Annual budget</span><b>${state.user.budget ? money(state.user.budget) : "Not set"}</b></div>
        ${chosenHabits.length ? `<div class="pref-habits">${chosenHabits.map(habit=>`<span class="pref-habit">${esc(habit)}</span>`).join("")}</div>` : `<p class="pref-empty">No lifestyle preferences yet — add a few so matching can find your people.</p>`}
        <button class="button subtle small" data-action="focus-profile-form">Edit preferences</button>
      </div>
    </section>` : hosting ? `
    <section class="profile-section">
      <div class="profile-section-head"><h2>Hosting</h2><p>Your published properties and incoming requests.</p></div>
      <div class="pref-card glass">
        <div class="pref-line"><span>Published properties</span><b>${mine}</b></div>
        <div class="pref-line"><span>Tour requests received</span><b>${hostRequests}</b></div>
        <div class="pref-line"><span>Confirmed bookings</span><b>${hostPaid}</b></div>
        <button class="button subtle small" data-tab="home">${icon("home")} Manage properties</button>
      </div>
    </section>` : ""}

    <section class="profile-section">
      <div class="profile-section-head"><h2>Profile details</h2><p>${tenant?"Your university, budget, and habits improve roommate recommendations.":hosting?"These details appear on your host profile.":"Your details appear to the people you connect with."}</p></div>
      <form class="profile-form glass form-stack" id="profileForm">
        <div class="two-fields"><label>Full name<input name="name" value="${esc(state.user.name)}" required></label><label>Phone number<input name="phone" type="tel" value="${esc(state.user.phone || "")}"></label></div>
        <label>University<select name="university">${state.universities.map(name=>`<option ${state.user.university===name?"selected":""}>${esc(name)}</option>`).join("")}</select></label>
        <label>About you<textarea name="bio" placeholder="${tenant?"Tell potential roommates a little about yourself":"Tell students about your experience and properties"}">${esc(state.user.bio || "")}</textarea></label>
        ${tenant?`<label>Maximum annual budget<input name="budget" type="number" inputmode="numeric" min="0" step="10000" value="${state.user.budget || ""}" placeholder="500000"></label>
        <label>Lifestyle preferences<div class="habit-picker">${habits.map(habit=>`<button type="button" class="habit ${(state.user.habits||[]).includes(habit)?"selected":""}" data-action="toggle-habit" data-habit="${habit}">${habit}</button>`).join("")}</div></label>`:""}
        <button class="button primary" type="submit">Save profile changes</button>
      </form>
    </section>

    <section class="profile-section">
      <div class="profile-section-head"><h2>Bookings &amp; payments</h2><p>Every booking on your account and its payment state.</p></div>
      ${bookingsList()}
    </section>

    <section class="profile-section">
      <div class="profile-section-head"><h2>Account</h2><p>Verification, settings, and admin tools.</p></div>
      <div class="settings-stack">
        <button class="settings-row" data-action="open-verification">${icon("verified")}<span><b>Verification</b><small>${esc(verificationStatusLabel())}</small></span><em>&rarr;</em></button>
        <button class="settings-row" data-action="open-settings">${icon("settings")}<span><b>Settings</b><small>Account, notifications, personalization, privacy</small></span><em>&rarr;</em></button>
        ${state.user.isCoreAdmin ? `<button class="settings-row" data-action="goto-admin">${icon("verified")}<span><b>Admin dashboard</b><small>Verification queue, review, audit trail</small></span><em>&rarr;</em></button>` : ""}
      </div>
    </section>`;
  $("#profileForm").onsubmit = saveProfile;
}

function renderSettings() {
  const notifyMessages = state.user.notifyMessages !== false;
  $("#tab-profile").innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Settings</span><h1>Settings</h1><p>Account, notifications, personalization, privacy, and legal.</p></div><div class="page-actions"><button class="button subtle" data-action="back-to-profile">&larr; My profile</button></div></div>
    <div class="settings-stack">
      <div class="settings-group-label">Account</div>
      <button class="settings-row" data-action="back-to-profile-edit">${icon("user")}<span><b>Edit profile details</b><small>Name, phone, university, bio, lifestyle</small></span><em>&rarr;</em></button>
      <button class="settings-row" data-action="open-password">${icon("lock")}<span><b>Change password</b><small>Update the password you sign in with</small></span><em>&rarr;</em></button>
      <button class="settings-row" data-action="open-verification">${icon("verified")}<span><b>Verification</b><small>${esc(verificationStatusLabel())}</small></span><em>&rarr;</em></button>
      ${canHost() ? `<button class="settings-row" data-action="switch-view">${icon("home")}<span><b>${inHostView() ? "Switch to guest view" : "Switch to host view"}</b><small>Same account, different tools</small></span><em>${inHostView() ? "Host" : "Guest"}</em></button>` : `<button class="settings-row" data-action="activate-host">${icon("home")}<span><b>Become a host</b><small>List your property while keeping your tenant account</small></span><em>&rarr;</em></button>`}

      <div class="settings-group-label">Notifications</div>
      <div class="settings-row toggle-row">
        <span><b>Message notifications</b><small>Add an activity notification for every new message</small></span>
        <button class="toggle ${notifyMessages ? "on" : ""}" data-action="toggle-message-notifs" role="switch" aria-checked="${notifyMessages}"><i></i></button>
      </div>
      <button class="settings-row" data-action="open-notifications">${icon("messages")}<span><b>Notification history</b><small>Everything Offkay has notified you about</small></span><em>&rarr;</em></button>

      <div class="settings-group-label">Personalization</div>
      <div class="settings-themes">
        ${["offkay","forest","slate","clay","midnight"].map(theme=>`<button class="theme-mini ${state.theme===theme?"active":""}" data-action="set-theme-settings" data-theme="${theme}">${theme[0].toUpperCase()+theme.slice(1)}</button>`).join("")}
      </div>

      <div class="settings-group-label">Privacy &amp; security</div>
      <button class="settings-row" data-action="open-connections">${icon("group")}<span><b>My connections</b><small>People you are connected with on Offkay</small></span><em>&rarr;</em></button>
      <button class="settings-row" data-action="logout-all-devices">${icon("lock")}<span><b>Sign out everywhere</b><small>End every session, including this device</small></span><em>&rarr;</em></button>

      <div class="settings-group-label">Legal</div>
      <button class="settings-row" data-action="open-terms">${icon("report")}<span><b>Terms &amp; Conditions</b><small>The rules of using Offkay</small></span><em>&rarr;</em></button>

      <div class="settings-group-label">Session</div>
      <button class="settings-row" data-action="confirm-logout">${icon("settings")}<span><b>Sign out</b><small>End this session on this device</small></span><em>&rarr;</em></button>
      <small class="settings-footnote">Offkay MVP &middot; signed in as ${esc(state.user.email)}</small>
    </div>`;
}

function passwordSheet() {
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Privacy &amp; security</span><h2>Change password</h2><p>Your new password must be at least 8 characters.</p></div><button class="close-button">&times;</button></div>
    <form class="sheet-form" id="passwordForm">
      <label>Current password<div class="password-field"><input name="currentPassword" type="password" autocomplete="current-password" required><button type="button" class="pw-toggle" data-toggle-for aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div></label>
      <label>New password<div class="password-field"><input name="newPassword" type="password" autocomplete="new-password" minlength="8" required><button type="button" class="pw-toggle" data-toggle-for aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div></label>
      <button class="button primary wide" type="submit">Update password</button>
    </form>`);
  $("#passwordForm").onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    setLoading(button, true, "Updating...");
    try {
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await request("/api/account/password",{method:"POST",body:JSON.stringify(values)});
      closeModal();
      toast("Password updated");
    } catch (error) { toast(error.message); }
    finally { setLoading(button, false); }
  };
}

function connectionsSheet() {
  const connected = (state.people || []).filter(item => item.connection?.state === "connected");
  const incoming = (state.people || []).filter(item => item.connection?.state === "incoming");
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Privacy &amp; connections</span><h2>My connections</h2><p>People you have accepted, and requests waiting on you.</p></div><button class="close-button">&times;</button></div>
    <div class="settings-stack">
      ${incoming.length ? `<div class="settings-group-label">Requests received</div>${incoming.map(person=>`
        <div class="settings-row">${avatarHtml(person.name, person.avatarUrl)}<span><b>${esc(person.name)}</b><small>${esc(person.university || "")}</small></span>
        <button class="button primary small" data-action="accept-connect" data-id="${person.connection.connectionId}">Accept</button></div>`).join("")}` : ""}
      <div class="settings-group-label">Connected (${connected.length})</div>
      ${connected.length ? connected.map(person=>`
        <div class="settings-row">${avatarHtml(person.name, person.avatarUrl)}<span><b>${esc(person.name)}</b><small>${esc(person.university || "")}</small></span>
        <button class="button subtle small" data-action="start-chat" data-id="${person.id}">Message</button></div>`).join("")
        : `<p class="share-hint">No connections yet. Find people in Explore &rarr; People and send a request.</p>`}
    </div>
    <button class="button primary wide" data-action="goto-people">Discover people &rarr;</button>`);
}

function termsSheet() {
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Legal</span><h2>Terms &amp; Conditions</h2><p>The short, honest version for the Offkay MVP.</p></div><button class="close-button">&times;</button></div>
    <div class="terms-body">
      <h3>1. Your account</h3><p>You are responsible for the details you publish and for keeping your password private. You can delete your account at any time from Settings, which removes your profile, listings, and messages.</p>
      <h3>2. Listings and bookings</h3><p>Landlords are responsible for the accuracy of their listings. A booking is only confirmed after every rent share is successfully paid and verified server-side by Offkay.</p>
      <h3>3. Payments</h3><p>Rent is processed by Paystack. Offkay currently charges no platform fee. Split-payment invite links are tied to a single booking and cannot be reused.</p>
      <h3>4. Community conduct</h3><p>Treat other members with respect. Connection requests, messages, and profiles must not be used for harassment, scams, or sharing anyone's private information. Use the report link on any listing to flag concerns &mdash; reports are private.</p>
      <h3>5. Verification</h3><p>Verification documents are reviewed manually and used only for identity checks. Offkay never publishes your NIN, ID photos, or contact details to other users.</p>
    </div>
    <button class="button primary wide" data-action="close-modal">Got it</button>`);
}

function logoutAllDevices() {
  modal(`
    <div class="modal-head"><div><h2>Sign out everywhere?</h2><p>Every signed-in session ends, including this one. You will need your password to sign back in.</p></div><button class="close-button">&times;</button></div>
    <div class="detail-actions"><button class="button subtle" data-action="close-modal">Cancel</button><button class="button danger" data-action="do-logout-all">Sign out everywhere</button></div>`);
}

async function doLogoutAll() {
  try { await request("/api/auth/logout-all",{method:"POST"}); }
  catch { /* clear locally even if the request failed */ }
  clearInterval(chatPoll);
  stopBadgePolling();
  state.user = null;
  state.activeTab = "home";
  state.activeConversation = null;
  state.messages = [];
  state.settingsView = false;
  closeModal();
  showAuth();
  setAuthMode("login");
  toast("Signed out on all devices");
  bootstrap();
}

async function toggleMessageNotifs() {
  const next = state.user.notifyMessages === false;
  try {
    const data = await request("/api/profile",{method:"PATCH",body:JSON.stringify({notifyMessages:next})});
    state.user = data.user;
    renderSettings();
    toast(next ? "Message notifications on" : "Message notifications off");
  } catch (error) { toast(error.message); }
}

function bookingsList() {
  const activeBookings = state.bookings.filter(booking => booking.status !== "cancelled");
  if (!activeBookings.length) return emptyState("No bookings yet","Choose a home and use Book &amp; split rent to create your first booking.");
  return `<div class="settings-stack booking-stack">${activeBookings.map(booking=>{
    const isTenant = booking.tenantId === state.user.id;
    const shares = Array.isArray(booking.paymentShares) && booking.paymentShares.length === booking.splitCount
      ? booking.paymentShares
      : Array.from({length:booking.splitCount},(u,i)=>i===0?booking.amount-Math.floor(booking.amount/booking.splitCount)*(booking.splitCount-1):Math.floor(booking.amount/booking.splitCount));
    const paidSlots = Array.isArray(booking.paidSlots) ? booking.paidSlots : [];
    const myShare = shares[0] ?? booking.amount;
    const paidCount = paidSlots.length;
    const fullyPaid = booking.status === "paid";
    const statusText = fullyPaid ? "paid"
      : booking.splitCount > 1 ? `${paidCount}/${booking.splitCount} shares paid`
      : "awaiting payment";
    const actions = [];
    if (isTenant && !fullyPaid && !paidSlots.includes(0)) actions.push(`<button class="button primary small" data-action="resume-payment" data-id="${booking.id}">Pay my share ${money(myShare)}</button>`);
    if (isTenant && booking.splitCount > 1 && !fullyPaid && state.paymentsEnabled) actions.push(`<button class="button subtle small" data-action="share-links" data-id="${booking.id}">Invite roommates</button>`);
    if (isTenant && !fullyPaid && paidSlots.length === 0 && booking.status !== "cancelled") actions.push(`<button class="button subtle small danger-text" data-action="cancel-booking" data-id="${booking.id}">Cancel</button>`);
    return `<div class="settings-row booking-row">
      <span class="metric-icon">${icon("home")}</span>
      <span><b>${esc(booking.propertyTitle || "Property")}</b><small>${isTenant?`Your share ${money(myShare)} · ${booking.splitCount>1?`split ${booking.splitCount} ways`:"solo"} · ${statusText}`:`${esc(booking.tenantName || "Student")} · ${money(booking.amount)} · ${booking.status.replace(/_/g," ")}`}</small></span>
      ${fullyPaid ? `<em>&#10003; Paid</em>` : actions.join(" ") || `<em>${booking.status.replace(/_/g," ")}</em>`}
    </div>`;
  }).join("")}</div>`;
}

async function saveProfile(event) {
  event.preventDefault();
  const button = event.submitter;
  setLoading(button,true,"Saving...");
  const form = new FormData(event.currentTarget);
  const habits = $$(".habit.selected").map(node=>node.dataset.habit);
  try {
    const data = await request("/api/profile",{method:"PATCH",body:JSON.stringify({
      name:form.get("name"),phone:form.get("phone"),university:form.get("university"),
      bio:form.get("bio"),budget:form.get("budget"),habits
    })});
    state.user = data.user;
    await refreshData(false);
    enterApp(); switchTab("profile"); toast("Profile updated");
  } catch(error) { toast(error.message); }
  finally { setLoading(button,false); }
}

function confirmLogout() {
  modal(`
    <div class="modal-head"><div><h2>Sign out of Offkay?</h2><p>You can sign back in any time with your email and password.</p></div><button class="close-button">&times;</button></div>
    <div class="detail-actions"><button class="button subtle" data-action="close-modal">Stay signed in</button><button class="button primary" data-action="do-logout">Sign out &rarr;</button></div>`);
}

async function doLogout() {
  try { await request("/api/auth/logout",{method:"POST"}); }
  catch { /* clear locally even if the request failed */ }
  clearInterval(chatPoll);
  stopBadgePolling();
  state.user = null;
  state.activeTab = "home";
  state.activeConversation = null;
  state.messages = [];
  state.settingsView = false;
  closeModal();
  showAuth();
  setAuthMode("login");
  toast("Signed out");
  bootstrap();
}

function confirmDeleteAccount() {
  modal(`
    <div class="modal-head"><div><h2>Delete your account?</h2><p>This removes your profile, properties, bookings, and all conversations. This cannot be undone.</p></div><button class="close-button">&times;</button></div>
    <form class="form-stack" id="deleteAccountForm">
      <label>Confirm your password<input name="password" type="password" autocomplete="current-password" placeholder="Your password" required></label>
      <button class="button danger wide" type="submit">Permanently delete my account</button>
    </form>`);
  $("#deleteAccountForm").onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    setLoading(button,true,"Deleting...");
    try {
      await request("/api/account",{method:"DELETE",body:JSON.stringify({password:new FormData(event.currentTarget).get("password")})});
      clearInterval(chatPoll);
      state.user = null;
      state.activeTab = "home";
      state.activeConversation = null;
      showAuth();
      setAuthMode("login");
      closeModal();
      toast("Account deleted");
    } catch(error) { toast(error.message); setLoading(button,false); }
  };
}

/* ============ Core Administrator dashboard ============ */
async function renderAdmin() {
  const host = $("#tab-admin");
  if (!host) return;
  host.innerHTML = `<div class="page-head"><div><h1>Admin dashboard</h1><p>Verification queue, review tools, and the full audit trail.</p></div></div><div class="no-chat"><div><div class="empty-icon">${icon("verified")}</div><b>Loading admin data…</b><p>Fetching the verification queue.</p></div></div>`;
  let overview, history;
  try {
    [overview, history] = await Promise.all([
      request("/api/admin/overview"),
      request("/api/admin/verification-history")
    ]);
  } catch (error) {
    host.innerHTML = `<div class="page-head"><div><h1>Admin dashboard</h1></div></div>${emptyState("Admin access required", error.message)}`;
    return;
  }
  const pending = overview.verifications || [];
  const events = history.events || [];
  host.innerHTML = `
    <div class="page-head"><div><h1>Admin dashboard</h1><p>Review verification submissions and manage the platform. Every action is recorded in the audit trail.</p></div></div>
    <div class="metrics">
      <div class="metric"><span class="metric-icon">&#9873;</span><div><small>Pending verifications</small><strong>${pending.length}</strong></div></div>
      <div class="metric"><span class="metric-icon">&#10003;</span><div><small>Reviews recorded</small><strong>${events.length}</strong></div></div>
      <div class="metric"><span class="metric-icon">&#9825;</span><div><small>Total users</small><strong>${overview.stats?.users ?? "—"}</strong></div></div>
    </div>
    <div class="admin-section glass">
      <div class="admin-section-head"><div><h2>Verification queue</h2><p>Open a submission to view documents and approve or reject.</p></div><span class="admin-count-pill">${pending.length} waiting</span></div>
      ${pending.length ? `<div class="admin-queue">${pending.map(item => `
      <div class="admin-row">
        <button class="person-main" data-action="admin-review" data-id="${item.id}">
          <span class="avatar">${avatarHtml(item.applicantName, item.applicantAvatarUrl)}</span>
          <span class="conversation-text"><b>${esc(item.applicantName)}</b><span>${esc(item.applicantEmail)} · ${esc(item.applicantUniversity || "")}</span></span>
        </button>
        <small class="admin-date">${new Date(item.createdAt).toLocaleDateString()}</small>
        <span class="status-tag pending">PENDING</span>
        <button class="button primary small" data-action="admin-review" data-id="${item.id}">Review</button>
      </div>`).join("")}</div>` : emptyState("Queue is clear", "No verification submissions are waiting for review.")}
    </div>
    <div class="admin-section glass">
      <div class="admin-section-head"><div><h2>Verification history</h2><p>Every approval and rejection, with the administrator who performed it.</p></div><span class="admin-count-pill">${events.length} recorded</span></div>
      ${events.length ? `<div class="admin-history">${events.map(event => `
      <div class="admin-row ${event.decision === "rejected" ? "rejected" : ""}">
        <span class="conversation-text"><b>${esc(event.userName)}</b><span>${esc(event.userEmail)}</span></span>
        <span class="status-tag ${event.decision === "approved" ? "ok" : "rejected"}">${event.decision === "approved" ? "VERIFIED" : "REJECTED"}</span>
        <span class="conversation-text admin-by"><span>by ${esc(event.reviewedByName)}</span><span>${new Date(event.reviewedAt).toLocaleString()}</span></span>
        ${event.reason ? `<span class="verify-reason">Reason: ${esc(event.reason)}</span>` : ""}
      </div>`).join("")}</div>` : emptyState("No reviews yet", "Approvals and rejections will appear here.")}
    </div>`;
}

async function adminReviewSheet(verificationId) {
  let overview;
  try { overview = await request("/api/admin/overview"); }
  catch (error) { return toast(error.message); }
  const item = (overview.verifications || []).find(entry => entry.id === verificationId);
  if (!item) return toast("Submission not found (it may have been reviewed already)");
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Verification review</span><h2>${esc(item.applicantName)}</h2><p>${esc(item.applicantEmail)} · ${esc(item.applicantRole)} · ${esc(item.applicantUniversity || "")}</p></div><button class="close-button">&times;</button></div>
    <div class="verify-panel">
      <div class="cost-row"><span>ID type</span><b>${esc(item.idType || "Student ID")}</b></div>
      <div class="cost-row"><span>NIN (masked)</span><b>${esc(item.ninMasked || "—")}</b></div>
      <div class="cost-row"><span>Submitted</span><b>${new Date(item.createdAt).toLocaleString()}</b></div>
      <div class="admin-docs">
        ${item.hasIdCard ? `<figure class="admin-doc"><img src="/api/admin/verification/${item.id}/document/idCard" alt="ID card upload" loading="lazy"><figcaption>ID card</figcaption></figure>` : `<span class="verify-reason">No ID card image</span>`}
        ${item.hasSupportDocument ? `<figure class="admin-doc"><img src="/api/admin/verification/${item.id}/document/support" alt="Support document upload" loading="lazy"><figcaption>Support document</figcaption></figure>` : `<span class="verify-reason">No support document</span>`}
      </div>
      <p class="share-hint">Images load through the admin-only document endpoint; open one in a new tab with a long-press or right-click if you need the full resolution.</p>
      <label style="display:grid;gap:7px"><span class="settings-group-label">Rejection reason (required when rejecting)</span>
        <input id="adminRejectReason" placeholder="e.g. Document is not readable"></label>
      <div class="modal-actions">
        <button class="button subtle" data-action="close-modal">Cancel</button>
        <button class="button danger" id="adminReject">Reject</button>
        <button class="button primary" id="adminApprove">Approve verification</button>
      </div>
    </div>`, true);
  $("#adminApprove").onclick = () => adminSubmitReview(verificationId, "approve", "");
  $("#adminReject").onclick = () => {
    const reason = ($("#adminRejectReason")?.value || "").trim();
    if (!reason) return toast("Enter a rejection reason first");
    adminSubmitReview(verificationId, "reject", reason);
  };
}

async function adminSubmitReview(verificationId, decision, reason) {
  try {
    await request(`/api/admin/verification/${verificationId}/review`,{method:"POST",body:JSON.stringify({decision,reason})});
    request("/api/badges").then(b => { state.adminPending = b.adminPending || 0; renderNotificationDot(); }).catch(() => {});
    closeModal();
    toast(decision === "approve" ? "Verification approved" : "Verification rejected");
    await refreshData(false);
    renderAdmin();
  } catch(error) { toast(error.message); }
}

function verificationSheet() {
  // Only NOT_VERIFIED and REJECTED users should ever reach the form.
  const statusLabel = verificationState();
  if (statusLabel === "VERIFIED") {
    return modal(`<div class="modal-head"><div><span class="eyebrow">Verification</span><h2>Already verified</h2><p>Your identity was reviewed and approved. Verification is complete — there is nothing to resubmit.</p></div><button class="close-button">&times;</button></div><div class="success"><div class="success-icon">&#10003;</div><button class="button primary wide" data-action="close-modal">Done</button></div>`);
  }
  if (statusLabel === "PENDING") {
    return modal(`<div class="modal-head"><div><span class="eyebrow">Verification</span><h2>Verification under review</h2><p>Your documents were submitted and are being reviewed by the Offkay team — usually within 24 hours. We'll show the result here; please don't submit again while the review is running.</p></div><button class="close-button">&times;</button></div><button class="button primary wide" data-action="close-modal">Got it</button>`);
  }
  const rejected = statusLabel === "REJECTED";
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Manual verification</span><h2>${rejected ? "Resubmit your documents" : "Verify your Offkay identity"}</h2><p>${rejected ? "Your last submission was rejected. Fix the issue and submit again." : "Submit your NIN and ID documents. Offkay reviews this manually before approval."}</p></div><button class="close-button">&times;</button></div>
    ${rejected && state.verification?.rejectionReason ? `<div class="payment-note">Rejection reason: ${esc(state.verification.rejectionReason)}</div>` : ""}
    <form class="sheet-form" id="verificationForm">
      <label>NIN<input name="nin" inputmode="numeric" placeholder="Enter your NIN" required></label>
      <label>ID type<select name="idType"><option>Student ID / Matric card</option><option>National ID</option><option>Driver's licence</option><option>International passport</option><option>Host property document</option></select></label>
      <label>ID card photo<input name="idCardImage" type="file" accept="image/*" required><small>Upload a clear photo. Do not upload passwords or payment cards.</small></label>
      <label>Supporting document<input name="supportDocument" type="file" accept="image/*"><small>Admission letter, matric slip, property ownership, or host authorization.</small></label>
      <button class="button primary wide" type="submit">Submit for manual review</button>
    </form>`);
  $("#verificationForm").onsubmit = submitVerification;
}

async function submitVerification(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setLoading(button,true,"Submitting…");
  try {
    const values = new FormData(form);
    const payload = {
      nin:values.get("nin"), idType:values.get("idType"),
      idCardImage:await fileToDataUrl(values.get("idCardImage")),
      supportDocument:await fileToDataUrl(values.get("supportDocument"))
    };
    const data = await request("/api/verification",{method:"POST",body:JSON.stringify(payload)});
    state.verification = data.verification; state.user = data.user;
    await refreshData(false); closeModal(); renderProfile(); toast("Verification submitted for manual review");
  } catch(error) { toast(error.message); setLoading(button,false); }
}

async function activateHost() {
  modal(`<div class="modal-head"><div><span class="eyebrow">Become a host</span><h2>Start hosting on Offkay</h2><p>Hosting is added to your account. You keep your bookings, saved homes, roommate profile, and guest controls.</p></div><button class="close-button">&times;</button></div><button class="button primary wide" id="activateHostButton">${icon("home")} Enable hosting</button>`);
  $("#activateHostButton").onclick = async event => {
    setLoading(event.currentTarget,true,"Switching…");
    try {
      const data = await request("/api/host/activate",{method:"POST"});
      state.user = data.user; state.hostView = true; localStorage.setItem("offkay-host-view","true"); await refreshData(false); closeModal(); enterApp(); switchTab("explore"); toast("Hosting activated. Your guest tools are still available in Settings.");
    } catch(error) { toast(error.message); }
  };
}

function confirmDeleteListing(id) {
  const item = state.ownListings.find(listing=>listing.id===id) || state.listings.find(listing=>listing.id===id);
  if (!item) return;
  modal(`
    <div class="modal-head"><div><h2>Delete “${esc(item.title)}”?</h2><p>The listing disappears from Explore immediately. Existing bookings and reports stay on record.</p></div><button class="close-button">&times;</button></div>
    <div class="detail-actions"><button class="button subtle" data-action="close-modal">Keep listing</button><button class="button danger" data-action="do-delete-listing" data-id="${id}">Delete permanently</button></div>`);
}

async function deleteListing(id) {
  try {
    await request(`/api/listings/${id}`,{method:"DELETE"});
    await refreshData(false);
    closeModal();
    renderAll();
    toast("Listing deleted");
  } catch(error) { toast(error.message); }
}

async function toggleListingStatus(id) {
  const item = state.ownListings.find(listing=>listing.id===id);
  if (!item) return;
  try {
    await request(`/api/listings/${id}`,{method:"PATCH",body:JSON.stringify({status:item.status==="active"?"hidden":"active"})});
    await refreshData(false);
    closeModal();
    renderAll();
    toast(item.status==="active"?"Listing hidden from Explore":"Listing published again");
  } catch(error) { toast(error.message); }
}

function emptyState(title, description, action = "") {
  return `<div class="empty-state glass"><div class="empty-icon">&#8962;</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
}

function openListing(id) {
  const item = state.listings.find(listing=>listing.id===id) || state.ownListings.find(listing=>listing.id===id);
  if (!item) return toast("Open a property from Explore first");
  const photos = (item.photos || []).slice(0, 4);
  const mainPhoto = photos[0];
  const mine = state.user && item.ownerId === state.user.id;
  const thumbs = photos.length > 1 ? `<div class="detail-thumbs">${photos.map((src,index)=>`<button type="button" class="detail-thumb${index===0?" active":""}" data-action="swap-photo" data-src="${src}" aria-label="Photo ${index+1}"><img src="${src}" alt="" loading="lazy"></button>`).join("")}</div>` : "";
  modal(`
    <div class="modal-head"><div><span class="eyebrow">${item.verified?"&#10003; Verified property":"&#9676; Verification under review"}</span></div><button class="close-button">&times;</button></div>
    <div class="listing-detail">
      <div class="detail-gallery">
        <div class="detail-image detail-gallery-main">${mainPhoto ? `<img src="${mainPhoto}" alt="${esc(item.title)}" draggable="false">` : `<div class="building"></div>`}<span class="map-pin">⌖ ${esc(item.area)}</span>${item.full?`<span class="verify-tag">Fully booked</span>`:""}</div>
        ${thumbs}
      </div>
      <div class="detail-copy">
        <span class="eyebrow">${esc(item.type)}</span><h2>${esc(item.title)}</h2><span>&#8982; ${esc(item.area)} &middot; ${esc(item.university)}</span>
        <div class="detail-facts">
          <div class="fact"><b>${item.bedrooms}</b><span>bedroom${item.bedrooms===1?"":"s"}</span></div>
          <div class="fact"><b>${item.bathrooms}</b><span>bathroom${item.bathrooms===1?"":"s"}</span></div>
          <div class="fact"><b>${esc(item.type)}</b><span>layout</span></div>
          <div class="fact"><b>${item.verified?"Yes":"Pending"}</b><span>verified</span></div>
          <div class="fact"><b>${item.occupied||0}/${item.capacity||item.bedrooms||1}</b><span>rooms taken</span></div>
        </div>
        <div class="detail-price">${money(item.price)} <small>/ academic year</small></div>
        ${(!item.proximity?.distanceText || item.proximity.distanceText === "0 m") ? `<div class="proximity-strip proximity-unknown">
          <span class="proximity-strong">Distance to campus unknown</span>
          <small>The host has not added exact coordinates for this home yet</small>
          <em>Ask the host for directions, or check the area on the map</em>
        </div>` : item.proximity?.distanceText ? `<div class="proximity-strip">
          <span class="proximity-strong">${esc(item.proximity.distanceText)}${item.proximity.etaText ? ` &middot; ${esc(item.proximity.etaText)}` : ""}</span>
          <small>from this home to ${esc(item.proximity.university)}</small>
          <em>${item.proximity.provider === "estimate" ? "straight-line estimate — actual road distance may differ" : `live route via ${esc(item.proximity.provider)}`}</em>
        </div>` : ""}
        <p>${esc(item.description || "The owner has not added a description yet.")}</p>
        <div class="amenities">${(item.amenities||[]).map(name=>`<span class="amenity">&#10003; ${esc(name)}</span>`).join("") || `<span class="amenity">No amenities listed</span>`}</div>
        ${mine ? `
        <div class="detail-actions">
          <button class="button subtle" data-action="edit-listing" data-id="${item.id}">Edit details</button>
          <button class="button primary" data-action="toggle-listing-status" data-id="${item.id}">${item.status==="active"?"Unpublish listing":"Publish listing"}</button>
          <button class="button danger" data-action="confirm-delete-listing" data-id="${item.id}">Delete listing</button>
        </div>
        <button class="report-link" data-action="open-inspections">See inspection requests</button>`
        : `
        <div class="detail-actions">
          <button class="button subtle" data-action="open-map" data-id="${item.id}">View on map</button>
          <button class="button subtle" data-action="contact-landlord" data-id="${item.id}">Message</button>
          <button class="button primary" data-action="open-inspection" data-id="${item.id}">Request inspection</button>
          ${item.full ? `<button class="button light" disabled>Fully booked</button>` : `<button class="button primary" data-action="start-booking" data-id="${item.id}">Book &amp; split rent</button>`}
        </div>
        ${item.full ? `<div class="payment-note">Every room here is already booked by a confirmed group. Browse the Explore tab for similar available homes.</div>` : ""}
        <div class="detail-host">
          <button type="button" class="host-chip" data-action="open-user-profile" data-id="${item.owner?.id || ""}" aria-label="Open host profile">
            ${avatarHtml(item.owner?.name || "Host", item.ownerAvatarUrl)}
            <span><b>${esc(item.owner?.name || "Offkay host")}</b><small>${item.owner?.verified ? "&#10003; Verified host" : "Offkay host"}</small></span>
          </button>
          <button type="button" class="link-button" data-action="booking-info">How booking works</button>
        </div>
        <button class="report-link" data-action="open-report" data-id="${item.id}">Report a concern</button>`}
      </div>
    </div>`,true);
}

function openMap(id) {
  const item = state.listings.find(listing=>listing.id===id) || state.ownListings.find(listing=>listing.id===id);
  if (!item) return;
  const coords = listingCoords(item);
  modal(`
    <div class="modal-head"><div><h2>${esc(item.title)}</h2><p>${esc(item.area)} · ${esc(item.university)}</p></div><button class="close-button">&times;</button></div>
    ${coords ? osmEmbed(item, 320) : `<div class="payment-note">This home has no map pin yet. Approximate location: ${esc(item.area)}.</div>`}
    <a class="button subtle wide" href="${mapUrl(item)}" target="_blank" rel="noreferrer">Open in OpenStreetMap ${coords ? "with exact pin" : "search"} &rarr;</a>
    <p class="share-hint">${coords ? "Pin shows the real neighborhood. The exact address is shared after booking." : "Pin the exact spot when editing the listing (latitude/longitude fields)."}</p>
  `, true);
}

async function startChat(id) {
  try {
    const data = await request("/api/conversations/start",{method:"POST",body:JSON.stringify({userId:id})});
    // Create/find the conversation first, then close the profile popup
    // BEFORE navigating so the chat is never left sitting under a modal.
    closeModal();
    state.openProfileId = null;
    // Splice the returned conversation straight into local state (the POST
    // reply carries the full payload) so the list needs no extra round-trip.
    const conversationId = data.conversationId;
    if (data.conversation && !state.conversations.some(item => item.id === conversationId)) {
      state.conversations.unshift(data.conversation);
    }
    state.activeConversation = conversationId;
    switchTab("messages");
    renderMessages();
    refreshData(false).catch(() => {});
    toast("Conversation started");
  } catch(error) { toast(error.message); }
}

function fileToDataUrl(file) {
  return new Promise((resolve,reject) => {
    if (!file) return resolve(null);
    if (file.size > 700000) return reject(new Error("Choose an image smaller than 700 KB for this MVP"));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("We could not read that image"));
    reader.readAsDataURL(file);
  });
}

function inspectionSheet(id) {
  const item = state.listings.find(listing => listing.id === id);
  if (!item) return;
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Inspection request</span><h2>See it before you book.</h2><p>Pick a window that works. The landlord will confirm it in Messages.</p></div><button class="close-button">&times;</button></div>
    <form class="sheet-form" id="inspectionForm" data-id="${item.id}">
      <div class="property-strip"><span class="property-thumb"></span><span><b>${esc(item.title)}</b><small>${esc(item.area)} · ${money(item.price)}/year</small></span></div>
      <label>Preferred date<input name="preferredDate" type="date" required></label>
      <fieldset class="segmented"><legend>Time window</legend><div class="segment-options"><label><input type="radio" name="timeWindow" value="Morning" checked><span>Morning</span></label><label><input type="radio" name="timeWindow" value="Afternoon"><span>Afternoon</span></label><label><input type="radio" name="timeWindow" value="Evening"><span>Evening</span></label></div></fieldset>
      <label>Optional photo or detail<input name="evidenceImage" type="file" accept="image/*"><small>Upload a photo of the property or location if it helps the inspector.</small></label>
      <label>Note for the landlord<textarea name="note" placeholder="For example: I’m coming from campus and would like to check the water and power."></textarea></label>
      <button class="button primary wide" type="submit">Request inspection</button>
    </form>`, false);
  $("#inspectionForm").onsubmit = submitInspection;
}

async function submitInspection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setLoading(button,true,"Sending…");
  try {
    const values = new FormData(form);
    const image = await fileToDataUrl(values.get("evidenceImage"));
    await request(`/api/listings/${form.dataset.id}/inspections`,{method:"POST",body:JSON.stringify({
      preferredDate:values.get("preferredDate"),timeWindow:values.get("timeWindow"),note:values.get("note"),evidenceImage:image
    })});
    await refreshData(false);
    modal(`<div class="success tour-success"><div class="success-orbit"><span>&#10003;</span></div><span class="eyebrow">Inspection requested</span><h2>You're on the list.</h2><p>We’ve sent your preferred window to the landlord. You’ll receive the confirmation in Messages.</p><button class="button primary wide" data-action="finish-inspection">Back to Offkay</button></div>`);
  } catch(error) { toast(error.message); setLoading(button,false); }
}

function inspectionsSheet() {
  const items = state.inspections || [];
  const hosting = state.user.role === "landlord" || inHostView();
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Inspections</span><h2>${hosting?"Tour requests":"Your requests"}</h2><p>${hosting?"Students who want to inspect one of your houses.":"Inspection requests you have sent to landlords."}</p></div><button class="close-button">&times;</button></div>
    <div class="inspection-list">${items.length ? items.map(inspection=>{
      const listing = state.listings.find(item=>item.id===inspection.listingId) || state.ownListings.find(item=>item.id===inspection.listingId);
      const isMine = inspection.tenantId === state.user.id;
      const other = !isMine ? state.roommateCandidates.find(item=>item.id===inspection.tenantId) : null;
      return `<div class="inspection-row"><span class="metric-icon">${icon("calendar")}</span><span><b>${esc(listing?.title || "House inspection")}</b><small>${esc(inspection.preferredDate || "Date pending")} &middot; ${esc(inspection.timeWindow)} &middot; ${esc(inspection.status)}${other ? ` · ${esc(other.name)}` : ""}</small></span></div>`;
    }).join("") : `<div class="empty-state"><div class="empty-icon">${icon("calendar")}</div><h3>No inspection requests yet</h3><p>Requests will appear here after a tenant chooses a viewing window.</p></div>`}</div>`);
}

function reportSheet(id) {
  const item = state.listings.find(listing => listing.id === id);
  if (!item) return;
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Safety review</span><h2>Report a concern</h2><p>Reports are private. Our team will review this listing before taking action.</p></div><button class="close-button">&times;</button></div>
    <form class="sheet-form" id="reportForm" data-id="${item.id}">
      <label>What feels suspicious?<select name="category"><option>Incorrect property details</option><option>Possible scam or payment pressure</option><option>Photos do not match the property</option><option>Unsafe location or building condition</option><option>Other concern</option></select></label>
      <label>Tell us what you noticed<textarea name="detail" minlength="8" required placeholder="Share enough detail for our review team to investigate."></textarea></label>
      <label>Add evidence (optional)<input name="evidenceImage" type="file" accept="image/*"><small>Never upload ID documents, payment cards, or passwords.</small></label>
      <button class="button danger wide" type="submit">Send private report</button>
    </form>`);
  $("#reportForm").onsubmit = submitReport;
}

async function submitReport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setLoading(button,true,"Sending…");
  try {
    const values = new FormData(form);
    await request("/api/reports",{method:"POST",body:JSON.stringify({
      listingId:form.dataset.id,category:values.get("category"),detail:values.get("detail"),
      evidenceImage:await fileToDataUrl(values.get("evidenceImage"))
    })});
    closeModal(); toast("Report received. Thank you for helping keep Offkay safe.");
  } catch(error) { toast(error.message); setLoading(button,false); }
}

function listingForm(item = {}) {
  const editing = Boolean(item.id);
  modal(`
    <div class="modal-head"><div><h2>${editing?"Edit property":"Add a new property"}</h2><p>Provide the details students need to make a confident decision.</p></div><button class="close-button">&times;</button></div>
    <form class="form-stack" id="listingForm">
      <div class="two-fields"><label>Property name<input name="title" value="${esc(item.title||"")}" placeholder="e.g. Palm Court Studio" required></label><label>Annual rent (&#8358;)<input name="price" type="number" min="50000" value="${item.price||""}" required></label></div>
      <label>University<select name="university">${state.universities.map(name=>`<option ${item.university===name||(!item.university&&state.user.university===name)?"selected":""}>${esc(name)}</option>`).join("")}</select></label>
      <label>Area / address<input name="area" value="${esc(item.area||"")}" placeholder="Akoka, Lagos" required></label>
      <div class="two-fields"><label>Latitude <input name="latitude" type="number" step="any" value="${item.latitude||""}" placeholder="6.5244"></label><label>Longitude <input name="longitude" type="number" step="any" value="${item.longitude||""}" placeholder="3.3792"></label></div>
      <div class="two-fields"><label>Property type<select name="type">${["Studio","Shared","En-suite","Self-contained","Apartment"].map(type=>`<option ${item.type===type?"selected":""}>${type}</option>`).join("")}</select></label><label>Bedrooms<input name="bedrooms" type="number" min="1" value="${item.bedrooms||1}"></label></div>
      <div class="two-fields"><label>Bathrooms<input name="bathrooms" type="number" min="1" value="${item.bathrooms||1}"></label><label>Amenities<input name="amenities" value="${esc((item.amenities||[]).join(", "))}" placeholder="Water, security, Wi-Fi"></label></div>
      <label>Property photos<input name="photos" type="file" accept="image/*" multiple><small>Use up to four clear photos. Each image should be smaller than 700 KB.</small></label>
      <label>Description<textarea name="description" placeholder="Describe the space, distance to campus, utilities, and house rules.">${esc(item.description||"")}</textarea></label>
      <button class="button primary wide" type="submit">${editing?"Save property":"Submit property for review"} &rarr;</button>
    </form>`);
  $("#listingForm").onsubmit = event => saveListing(event,item.id);
}

async function saveListing(event,id) {
  event.preventDefault();
  const button = event.submitter; setLoading(button,true,id?"Saving...":"Publishing...");
  const data = Object.fromEntries(new FormData(event.currentTarget));
  data.amenities = data.amenities.split(",").map(item=>item.trim()).filter(Boolean);
  try {
    const imageFiles = [...event.currentTarget.querySelector("[name=photos]").files].slice(0,4);
    data.photos = imageFiles.length ? await Promise.all(imageFiles.map(fileToDataUrl)) : (id ? undefined : []);
    await request(id?`/api/listings/${id}`:"/api/listings",{method:id?"PATCH":"POST",body:JSON.stringify(data)});
    await refreshData(false); closeModal(); renderAll(); switchTab("explore"); toast(id?"Property updated":"Property submitted for review");
  } catch(error) { toast(error.message); }
  finally { setLoading(button,false); }
}

async function saveListingToggle(id) {
  try {
    const data = await request(`/api/listings/${id}/save`,{method:"POST"});
    const item = state.listings.find(listing=>listing.id===id); if(item)item.saved=data.saved;
    renderHome(); renderExplore(); toast(data.saved?"Saved to your shortlist":"Removed from saved homes");
  } catch(error) { toast(error.message); }
}

async function contactLandlord(id) {
  try {
    const data = await request(`/api/listings/${id}/contact`,{method:"POST"});
    await refreshData(false); state.activeConversation=data.conversationId; closeModal(); switchTab("messages"); renderMessages();
  } catch(error) { toast(error.message); }
}

function shareRows(price, splitCount) {
  if (splitCount <= 1) return "";
  const base = Math.floor(price / splitCount);
  const shares = Array.from({ length: splitCount }, (unused, index) => index === 0 ? price - base * (splitCount - 1) : base);
  return `<div class="share-breakdown">${shares.map((amount, index) => `
    <div class="cost-row share-row"><span>${index === 0 ? "Your share" : `Roommate ${index}`}</span><b>${money(amount)}</b></div>`).join("")}
    <div class="share-hint">Each roommate pays their own share. After your payment, you'll get invite links to send them.</div>
  </div>`;
}

function startBooking(id) {
  const item = state.listings.find(listing=>listing.id===id);
  if (!item) return;
  if (item.full) return toast("This property is fully booked already. Try the Explore tab for similar homes.");
  const breakdown = () => shareRows(item.price, Number(document.querySelector("input[name=splitCount]:checked")?.value || 1));
  modal(`
    <div class="modal-head"><div><h2>Secure your space</h2><p>Review the booking before continuing to payment.</p></div><button class="close-button">&times;</button></div>
    <div class="checkout-card"><div class="checkout-thumb"></div><div><b>${esc(item.title)}</b><span>${esc(item.area)} &middot; ${esc(item.university)}</span><span style="color:var(--green);font-weight:800">&#10003; Property and owner reviewed</span></div></div>
    <div class="cost-row"><span>Annual rent</span><b>${money(item.price)}</b></div>
    <fieldset class="segmented split-segment"><legend>How would you like to pay?</legend><div class="segment-options"><label><input type="radio" name="splitCount" value="1" checked><span>Pay alone</span></label><label><input type="radio" name="splitCount" value="2"><span>Split 2 ways</span></label><label><input type="radio" name="splitCount" value="3"><span>Split 3 ways</span></label><label><input type="radio" name="splitCount" value="4"><span>Split 4 ways</span></label></div></fieldset>
    <div id="shareBreakdown">${breakdown()}</div>
    <div class="cost-row"><span>Offkay fee</span><b>&#8358;0 launch offer</b></div>
    <div class="cost-row"><span>Payment protection</span><b>Included</b></div>
    <div class="cost-row total"><span>Total</span><span>${money(item.price)}</span></div>
    <div class="payment-note">You'll complete checkout on Paystack's secure page and return here for automatic verification. Your booking activates once every share is confirmed server-side.</div>
    <button class="button primary wide" id="createBooking" data-id="${item.id}">Continue to secure payment &rarr;</button>`, state.paymentsEnabled);
  document.querySelectorAll("input[name=splitCount]").forEach(radio => radio.addEventListener("change", () => {
    $("#shareBreakdown").innerHTML = breakdown();
  }));
  $("#createBooking").onclick = createBooking;
}

async function createBooking(event) {
  const button=event.currentTarget; setLoading(button,true,"Creating booking...");
  try {
    const splitCount = Number(document.querySelector("input[name=splitCount]:checked")?.value || 1);
    const data = await request("/api/bookings",{method:"POST",body:JSON.stringify({listingId:button.dataset.id,splitCount})});
    payBooking(data.booking, button);
  } catch(error) { toast(error.message); setLoading(button,false); }
}

function payBooking(booking, button, slot = 0) {
  if (button) setLoading(button,true,"Opening secure checkout...");
  if (state.paymentsEnabled) {
    request(`/api/bookings/${booking.id}/pay/initialize`,{method:"POST",body:JSON.stringify({slot})})
      .then(data => { window.location.href = data.authorizationUrl; })
      .catch(error => { toast(error.message); if (button) setLoading(button,false); });
    return;
  }
  showPayment(booking);
}

function resumePayment(id) {
  const booking = state.bookings.find(item => item.id === id);
  if (!booking) return toast("Booking not found");
  const nextSlot = Array.isArray(booking.paidSlots) ? [0,1,2,3].find(index => index < booking.splitCount && !booking.paidSlots.includes(index)) : 0;
  if (nextSlot === undefined && booking.status !== "paid") return toast("All shares are processing - verification lands shortly");
  payBooking(booking, null, nextSlot ?? 0);
}

async function cancelBooking(id) {
  modal(`
    <div class="modal-head"><div><h2>Cancel this booking?</h2><p>The property goes back on the market and no payment is collected.</p></div><button class="close-button">&times;</button></div>
    <div class="modal-actions"><button class="button subtle" data-action="close-modal">Keep booking</button><button class="button danger" id="confirmCancelBooking">Yes, cancel it</button></div>`);
  $("#confirmCancelBooking").onclick = async () => {
    try {
      await request(`/api/bookings/${id}/cancel`,{method:"POST"});
      await refreshData();
      closeModal(); enterApp(); switchTab("profile");
      toast("Booking cancelled");
    } catch(error) { toast(error.message); }
  };
}

async function shareLinks(id) {
  try {
    const data = await request(`/api/bookings/${id}/share`,{method:"POST"});
    const links = data.links || [];
    if (!links.length) return toast("No roommate shares on this booking");
    modal(`
      <div class="modal-head"><div><h2>Invite your roommates</h2><p>Each person pays their own share directly to this booking.</p></div><button class="close-button">&times;</button></div>
      <div class="share-links">${links.map(link => `
        <div class="share-link-row">
          <div><b>Roommate ${link.slot}</b><span>${money(link.amount)}</span></div>
          <input class="share-link-input" readonly value="${esc(link.url)}">
          <button class="button subtle small" data-copy-link="${esc(link.url)}">Copy</button>
        </div>`).join("")}
      </div>
      <div class="payment-note">Send each link to a roommate. When they pay, the share is verified and marked here automatically.</div>
      <button class="button primary wide" data-action="close-modal">Done</button>`);
    document.querySelectorAll("[data-copy-link]").forEach(button => button.addEventListener("click", () => {
      navigator.clipboard?.writeText(button.dataset.copyLink).then(() => toast("Link copied")).catch(() => toast("Copy failed - long-press the link instead"));
    }));
  } catch(error) { toast(error.message); }
}

function showPayment(booking) {
  modal(`
    <div class="modal-head"><div><h2>Test payment</h2><p>This preview server has no Paystack key configured, so booking confirmation runs in demo mode.</p></div><button class="close-button">&times;</button></div>
    <div class="checkout-card"><div class="checkout-thumb"></div><div><b>Booking ${esc(booking.id.slice(-8).toUpperCase())}</b><span>Amount due now</span></div></div>
    <div class="cost-row"><span>${booking.splitCount > 1 ? `Your share (${booking.splitCount} people)` : "Your payment"}</span><b>${money(booking.paymentShare || Math.round(booking.amount/booking.splitCount))}</b></div>
    <div class="cost-row total"><span>Booking total</span><span>${money(booking.amount)}</span></div>
    <div class="payment-note">No bank card is charged in this mode. With a live Paystack key, this button takes you to a secure Paystack checkout and the booking only activates after server-side verification.</div>
    <button class="button primary wide" id="confirmPayment">Confirm test payment &rarr;</button>`);
  $("#confirmPayment").onclick = async event => {
    setLoading(event.currentTarget,true,"Verifying payment...");
    try {
      const data = await request(`/api/bookings/${booking.id}/confirm-payment`,{method:"POST"});
      await refreshData(false);
      modal(`<div class="success"><div class="success-icon">&#10003;</div><h2>Payment confirmed</h2><p>Your booking is now active. Reference: <b>${esc(data.booking.reference)}</b>. The landlord can see the confirmed booking and you can continue the conversation in Messages.</p><button class="button primary wide" data-action="finish-payment">View my home</button></div>`);
    } catch(error) { toast(error.message); }
  };
}

async function openMatches() {
  // "Find a roommate" is a discovery action: it must never open the landlord
  // "Add a new property" form. Tenants go to the Explore tab's Roommate
  // matching (the best-match modal below still opens on top); everyone else
  // gets the People directory, which the server serves for every role - the
  // Roommates mode would be empty for them because /api/session only computes
  // roommateCandidates for tenants.
  closeModal();
  state.exploreMode = state.user.role === "tenant" ? "roommates" : "people";
  switchTab("explore");
  if (state.user.role !== "tenant") {
    toast("Roommate matching is for tenant accounts - browse compatible people in Explore.");
    return;
  }
  try {
    const data = await request("/api/roommates");
    if (!data.matches.length) {
      return modal(`<div class="modal-head"><div><h2>Roommate matching</h2><p>Complete your profile so we can calculate compatible matches.</p></div><button class="close-button">&times;</button></div>${emptyState("No match ready yet","Add your budget, university, and lifestyle preferences in Profile.")}`);
    }
    const match = data.matches[0];
    modal(`
      <div class="modal-head"><div><span class="eyebrow">Best roommate match</span></div><button class="close-button">&times;</button></div>
      <div class="match-card">
        <div class="match-person"><span class="match-score">${match.score}% match</span></div>
        <div class="match-info"><span>${esc(match.university || "University not set")}</span><h2>${esc(match.name)}</h2><p>${match.bio ? esc(match.bio) : "This student has not completed their profile yet - connect to learn more about them."}</p>
          <div class="amenities">${(match.habits||[]).map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("")}<span class="amenity">Budget ${money(match.budget||0)}</span></div>
          <div class="match-actions"><button class="button subtle" data-action="close-modal">Maybe later</button><button class="button primary" data-action="connect-roommate" data-id="${match.id}">Connect with ${esc(firstName(match.name))} &rarr;</button></div>
        </div>
      </div>`,true);
  } catch(error) { toast(error.message); }
}

function roommateProfile(id) {
  const match = state.roommateCandidates.find(item => item.id === id);
  if (!match) return toast("Roommate profile not found");
  modal(`
    <div class="modal-head"><div><span class="eyebrow">${match.score ? `${match.score}% match` : "Roommate"}</span><h2>${esc(match.name)}</h2><p>${esc(match.university || "University not set")}</p></div><button class="close-button">&times;</button></div>
    <div class="match-card">
      <div class="match-person"><span class="match-score">${match.score ? `${match.score}% match` : "Roommate"}</span></div>
      <div class="match-info">
        <h2>${esc(firstName(match.name))}'s profile</h2>
        <p>${match.bio ? esc(match.bio) : "This student has not written an about-me yet."}</p>
        <div class="cost-row"><span>Budget ceiling</span><b>${money(match.budget || 0)}</b></div>
        <div class="amenities">${(match.habits||[]).map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("") || `<span class="amenity">No habits yet</span>`}</div>
        <div class="match-actions"><button class="button subtle" data-action="close-modal">Close</button><button class="button primary" data-action="connect-roommate" data-id="${match.id}">Start conversation</button></div>
      </div>
    </div>`, true);
}

async function connectRoommate(id) {
  try {
    const data = await request("/api/roommates/connect",{method:"POST",body:JSON.stringify({userId:id})});
    await refreshData(false); state.activeConversation=data.conversationId; closeModal(); switchTab("messages"); renderMessages(); toast("Roommate conversation started");
  } catch(error) { toast(error.message); }
}

async function refreshData(render = true) {
  const data = await request("/api/bootstrap");
  Object.assign(state,data);
  if (render) renderAll();
}

function bindEvents() {
  document.addEventListener("click", async event => {
    const tab = event.target.closest("[data-tab]");
    if (tab && state.user) { event.preventDefault(); switchTab(tab.dataset.tab); return; }
    const auth = event.target.closest("[data-auth-mode]");
    if (auth) {
      setAuthMode(auth.dataset.authMode);
      return;
    }
    const google = event.target.closest("[data-google]");
    if (google) {
      window.location.href = "/api/auth/google";
      return;
    }
    const role = event.target.closest("[data-role]");
    if (role) {
      $$(".role-option, .account-type-card").forEach(item=>item.classList.toggle("active",item===role));
      const roleForm = role.closest("form");
      if (roleForm) roleForm.querySelector("[name=role]").value = role.dataset.role;
      if (role.closest("#signupForm")) toggleSignupUniversity(role.dataset.role === "tenant");
      return;
    }
    const eye = event.target.closest("[data-action='toggle-password']");
    if (eye) {
      const input = eye.parentElement.querySelector("input");
      if (input) {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
        eye.classList.toggle("showing", show);
      }
      return;
    }
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return;
    const {action,id} = actionNode.dataset;
    if (action==="view-listing") openListing(id);
    if (action==="save-listing") saveListingToggle(id);
    if (action==="new-listing") listingForm();
    if (action==="edit-listing") listingForm(state.ownListings.find(item=>item.id===id) || state.listings.find(item=>item.id===id));
    if (action==="confirm-delete-listing") confirmDeleteListing(id);
    if (action==="do-delete-listing") deleteListing(id);
    if (action==="toggle-listing-status") toggleListingStatus(id);
    if (action==="contact-landlord") contactLandlord(id);
    if (action==="start-booking") startBooking(id);
    if (action==="open-inspection") inspectionSheet(id);
    if (action==="open-report") reportSheet(id);
    if (action==="open-inspections") inspectionsSheet();
    if (action==="open-matches") openMatches();
    if (action==="view-roommate") roommateProfile(id);
    if (action==="connect-roommate") connectRoommate(id);
    if (action==="close-modal") closeModal();
    if (action==="finish-inspection") {closeModal();switchTab("messages");toast("Inspection request saved");}
    if (action==="open-verification") verificationSheet();
    if (action==="admin-review") adminReviewSheet(id);
    if (action==="goto-admin") switchTab("admin");
    if (action==="activate-host") activateHost();
    if (action==="confirm-logout") confirmLogout();
    if (action==="do-logout") doLogout();
    if (action==="change-avatar") changeAvatar();
    if (action==="confirm-delete-account") confirmDeleteAccount(); // endpoint kept; UI entry removed
    if (action==="resume-payment") resumePayment(id);
    if (action==="share-links") shareLinks(id);
    if (action==="cancel-booking") cancelBooking(id);
    if (action==="open-map") openMap(id);
    if (action==="start-chat") startChat(id);
    if (action==="switch-view") {
      state.hostView = !state.hostView;
      localStorage.setItem("offkay-host-view", String(state.hostView));
      closeModal(); enterApp(); switchTab("home");
      toast(state.hostView ? "Host view enabled" : "Guest view enabled");
    }
    if (action==="set-theme") applyTheme(actionNode.dataset.theme);
    if (action==="explore-mode") {switchExploreMode(actionNode.dataset.mode);}
    if (action==="finish-payment") {closeModal();switchTab("home");renderHome();toast("Booking confirmed");}
    if (action==="filter-type") {state.filters.homes.type=actionNode.dataset.type;renderExplore();}
    if (action==="reset-home-filters") {state.filters.homes={query:"",university:"",type:"All",maxPrice:"",bedrooms:"",verified:false};renderExplore();}
    if (action==="reset-home-filters-sheet") {state.filters.homes={query:"",university:"",type:"All",maxPrice:"",bedrooms:"",verified:false};openAdvancedFilters();}
    if (action==="apply-advanced-filters") {closeModal();renderExplore();}
    if (action==="toggle-home-verified") {state.filters.homes.verified=!state.filters.homes.verified;renderExplore();}
    if (action==="toggle-roommate-verified") {state.filters.roommates.verified=!state.filters.roommates.verified;renderExplore();}
    if (action==="toggle-people-connected") {state.filters.people.connected=!state.filters.people.connected;renderExplore();}
    if (action==="open-advanced-filters") {openAdvancedFilters();}
    if (action==="swap-photo") {
      const main = document.querySelector(".detail-gallery-main img");
      if (main && actionNode.dataset.src) {
        main.src = actionNode.dataset.src;
        document.querySelectorAll(".detail-thumb").forEach(node=>node.classList.toggle("active",node===actionNode));
      }
    }
    if (action==="booking-info") {
      modal(`
        <div class="modal-head"><div><span class="eyebrow">Booking</span><h2>How booking works</h2><p>Split rent with your group, confirmed through Offkay.</p></div><button class="close-button">&times;</button></div>
        <div class="booking-steps">
          <div><b>1</b><span>Request an inspection or message the host with any questions.</span></div>
          <div><b>2</b><span>Book the home and split the annual rent with your group members.</span></div>
          <div><b>3</b><span>The host confirms. Offkay verifies the payment and your rooms are locked in.</span></div>
        </div>
        <button class="button primary wide" data-action="close-modal">Got it</button>`);
    }
    if (action==="open-image-viewer") {
      const img = actionNode.querySelector("img");
      openImageViewer(img ? img.getAttribute("src") : "", img ? img.alt : "");
    }
    if (action==="close-image-viewer") {closeImageViewer();}
    if (action==="reset-roommate-filters") {state.filters.roommates={query:"",university:"",maxBudget:"",habit:"",verified:false};renderExplore();}
    if (action==="open-conversation") {state.activeConversation=id;renderMessages();}
    if (action==="back-to-conversations") {state.activeConversation=null;setChatPolling(null);renderMessages();}
    if (action==="toggle-habit") actionNode.classList.toggle("selected");
    if (action==="open-notifications") openNotifications();
    if (action==="mark-notifications-read") markNotificationsRead();
    if (action==="open-notification") openNotificationDeepLink(actionNode);
    if (action==="send-connect") sendConnect(id, actionNode);
    if (action==="accept-connect") respondConnect(id, true, actionNode);
    if (action==="decline-connect") respondConnect(id, false, actionNode);
    if (action==="open-user-profile") openUserProfile(id);
    if (action==="open-settings") { state.settingsView = true; renderProfile(); }
    if (action==="back-to-profile") { state.settingsView = false; renderProfile(); }
    if (action==="back-to-profile-edit") { state.settingsView = false; renderProfile(); }
    if (action==="open-password") passwordSheet();
    if (action==="focus-profile-form") { state.settingsView = false; renderProfile(); requestAnimationFrame(()=>{ const form=$("#profileForm"); if(form) form.scrollIntoView({behavior:"smooth",block:"center"}); }); }
    if (action==="open-connections") connectionsSheet();
    if (action==="open-terms") termsSheet();
    if (action==="logout-all-devices") logoutAllDevices();
    if (action==="do-logout-all") doLogoutAll();
    if (action==="toggle-message-notifs") toggleMessageNotifs();
    if (action==="set-theme-settings") { applyTheme(actionNode.dataset.theme); renderSettings(); }
    if (action==="goto-people") { closeModal(); state.exploreMode = "people"; switchTab("explore"); }
    if (action==="reset-people-filters") { state.filters.people = { query:"", university:"", connected:false }; renderExplore(); }
    if (action==="pick-attachment") pickAttachment();
    if (action==="remove-attachment") { pendingChatAttachments.splice(Number(id) || 0, 1); renderPendingAttachments(); }
    if (action==="record-voice") startVoiceRecording();
    if (action==="cancel-recording") cancelVoiceRecording();
    if (action==="stop-recording") stopVoiceRecording(false);
  });

  $("#notificationButton").addEventListener("click", () => { if (state.user) openNotifications(); });
  $("#modalRoot").addEventListener("click", event => {
    if (event.target===$("#modalRoot")) { if($("#modalRoot").classList.contains("viewer")) closeImageViewer(); else closeModal(); }
    else if (event.target.classList?.contains("image-viewer")) closeImageViewer();
  });
  $("#loginForm").addEventListener("submit", login);
  $("#signupForm").addEventListener("submit", signup);
  $("#forgotForm").addEventListener("submit", forgotPassword);
  $("#resetForm").addEventListener("submit", submitReset);
  document.addEventListener("change", event => { if (event.target.id === "chatFileInput" && event.target.files?.length) handlePickedFiles(event.target.files); });
  $("#logoutButton").addEventListener("click", confirmLogout);
  $("#globalSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      state.filters.homes.query=event.currentTarget.value;state.exploreMode="homes";switchTab("explore");renderExplore();
    }
  });
  document.addEventListener("keydown",event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();$("#globalSearch").focus();}
    if(event.key==="Escape"){
      if($("#modalRoot").classList.contains("viewer")){closeImageViewer();return;}
      closeModal();
    }
  });
  document.addEventListener("input",event=>{
    const filter = event.target.dataset.filter;
    if(filter==="home-query") {
      state.filters.homes.query=event.target.value;
      if(event.target.classList.contains("explore-input")) {
        renderExplore();
        const retry=document.querySelector(".explore-input");
        if(retry){retry.focus();retry.setSelectionRange(retry.value.length,retry.value.length);}
      }
    }
    if(filter==="roommate-query") state.filters.roommates.query=event.target.value;
    if(filter==="people-query") { state.filters.people.query=event.target.value; renderExplore(); const retry=document.querySelector('[data-filter="people-query"]'); if(retry){retry.focus();retry.setSelectionRange(retry.value.length,retry.value.length);} }
    if(event.target.id==="conversationSearch"){
      state.conversationQuery = event.target.value;
      $("#conversationRows").innerHTML = visibleConversations().map(conversationRow).join("") || `<div class="no-conv-hint">No conversation matches that search.</div>`;
    }
  });
  document.addEventListener("change",event=>{
    const filter = event.target.dataset.filter;
    if (!filter) return;
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    const [group, key] = filter.split("-");
    if (group === "home") {
      const field = ({university:"university",price:"maxPrice",bedrooms:"bedrooms",verified:"verified"})[key];
      if (field) state.filters.homes[field] = value;
    }
    if (group === "roommate") {
      const field = ({university:"university",budget:"maxBudget",habit:"habit",verified:"verified"})[key];
      if (field) state.filters.roommates[field] = value;
    }
    if (filter.startsWith("people-")) {
      const field = ({university:"university",connected:"connected"})[key];
      if (field) state.filters.people[field] = value;
    }
    renderExplore();
  });
  document.addEventListener("keydown",event=>{
    const filter = event.target.dataset?.filter;
    if ((filter==="home-query" || filter==="roommate-query") && event.key==="Enter") {
      event.preventDefault();
      renderExplore();
    }
    // Keyboard activation for whole-card links (role="link" articles).
    if ((event.key==="Enter" || event.key===" ") && event.target.getAttribute?.("role")==="link") {
      event.preventDefault();
      const id = event.target.dataset.id;
      if (event.target.dataset.action==="view-listing" && id) viewListing(id);
    }
  });
}

async function login(event) {
  event.preventDefault();
  const button=event.submitter;setLoading(button,true,"Signing in...");
  try {
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const data=await request("/api/auth/login",{method:"POST",body:JSON.stringify(values)});
    state.user=data.user;await refreshData(false);enterApp();toast(`Welcome back, ${firstName(state.user.name)}`);
  } catch(error){
    showAuthBanner("error", isDbDown(error) ? dbDownMessage() : error.message);
  }
  finally{setLoading(button,false)}
}

async function signup(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button=event.submitter;setLoading(button,true,"Creating account...");
  showAuthBanner("");
  try {
    const values=Object.fromEntries(new FormData(form));
    if (values.password !== values.confirmPassword) {
      showAuthBanner("error", "Passwords do not match - re-enter them so both fields are identical.");
      return;
    }
    const { confirmPassword, ...payload } = values;
    const data=await request("/api/auth/signup",{method:"POST",body:JSON.stringify(payload)});
    state.user=data.user;await refreshData(false);enterApp();toast("Your Offkay account is ready");
  } catch(error){
    if (error.message.includes("already exists")) {
      setAuthMode("login");
      const savedEmail = $("#signupForm [name=email]")?.value || "";
      if (savedEmail) $("#loginForm [name=email]").value = savedEmail;
      showAuthBanner("error", "That email is registered. Sign in instead - details pre-filled.");
    } else if (error.message.includes("Passwords do not match")) {
      showAuthBanner("error", "Passwords do not match - re-enter them so both fields are identical.");
    } else {
      // Storage failures get the server's actionable message verbatim (missing
      // MONGODB_URI etc.); other errors surface in the inline banner.
      showAuthBanner("error", /cannot be saved/i.test(error.message) ? error.message : (isDbDown(error) ? dbDownMessage() : error.message));
    }
  }
  finally{setLoading(button,false)}
}

bindEvents();
bindPasswordToggles();
consumeAuthQueryFlags();
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken && !state.user) startResetFlow(urlToken);
bootstrap();
