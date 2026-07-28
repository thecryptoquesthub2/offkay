const state = {
  user: null,
  universities: [],
  listings: [],
  roommateCandidates: [],
  verification: null,
  conversations: [],
  bookings: [],
  inspections: [],
  activeTab: "home",
  activeConversation: null,
  messages: [],
  filters: { query: "", university: "", type: "All", maxPrice: "" },
  exploreMode: "homes",
  theme: localStorage.getItem("offkay-theme") || "offkay"
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const money = value => `&#8358;${Number(value || 0).toLocaleString("en-NG")}`;
const initials = name => String(name || "?").split(/\s+/).map(part => part[0]).join("").slice(0,2).toUpperCase();
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
const time = iso => new Intl.DateTimeFormat("en-NG",{hour:"numeric",minute:"2-digit"}).format(new Date(iso));
const firstName = name => String(name || "").split(" ")[0];
const mapUrl = listing => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${listing.area}, ${listing.university}, Nigeria`)}`;
const icon = name => `<svg class="off-icon" aria-hidden="true"><use href="/offkay-icons.svg#${name}"></use></svg>`;

function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem("offkay-theme", theme);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: options.body ? {"Content-Type":"application/json",...(options.headers || {})} : options.headers,
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Something went wrong");
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
}

function setAuthMode(mode) {
  const signup = mode === "signup";
  $("#loginForm").classList.toggle("hidden", signup);
  $("#signupForm").classList.toggle("hidden", !signup);
  $("#authEyebrow").textContent = signup ? "Join Offkay" : "Offkay";
  $("#authTitle").textContent = signup ? "Create your account" : "Sign in";
  $("#authSubtitle").textContent = signup
    ? "Choose how you will use Offkay. You can update your details later."
    : "Access your housing, messages, and bookings.";
}

async function bootstrap() {
  try {
    const data = await request("/api/bootstrap");
    Object.assign(state, data);
    applyTheme(state.theme);
    populateUniversities();
    if (state.user) enterApp(); else showAuth();
  } catch (error) {
    toast(error.message);
  }
}

function populateUniversities() {
  const select = $("#signupUniversity");
  if (select) select.innerHTML = state.universities.map(name => `<option>${esc(name)}</option>`).join("");
}

function showAuth() {
  $("#authScreen").classList.remove("hidden");
  $("#app").classList.add("hidden");
}

function enterApp() {
  $("#authScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#topAvatar").textContent = initials(state.user.name);
  $("#topName").textContent = firstName(state.user.name);
  $("#topRole").textContent = state.user.role === "landlord" ? "Landlord" : "Tenant";
  $("#messageBadge").style.display = state.conversations.length ? "block" : "none";
  $("#sidebarCard").innerHTML = state.user.role === "landlord"
    ? `<span>Grow your portfolio</span><strong>Publish a verified property in minutes.</strong><button class="button light small" data-action="new-listing">Add property</button>`
    : `<span>Roommate Match</span><strong>Living is easier with the right person.</strong><button class="button light small" data-action="open-matches">Find a match</button>`;
  renderAll();
}

function renderAll() {
  renderHome();
  renderExplore();
  renderMessages();
  renderProfile();
  switchTab(state.activeTab, false);
}

function switchTab(tab, render = true) {
  state.activeTab = tab;
  $$(".tab").forEach(node => node.classList.toggle("active", node.id === `tab-${tab}`));
  $$("[data-tab]").forEach(node => node.classList.toggle("active", node.dataset.tab === tab));
  if (render) {
    if (tab === "messages") renderMessages();
    if (tab === "explore") renderExplore();
    if (tab === "profile") renderProfile();
    if (tab === "home") renderHome();
  }
  window.scrollTo({top:0,behavior:"smooth"});
}

function listingCard(listing, landlordMode = false) {
  const photo = listing.photos?.[0];
  return `<article class="listing-card">
    <div class="listing-image ${esc(listing.accent || "emerald")}">
      ${photo ? `<img src="${photo}" alt="${esc(listing.title)}">` : ""}
      <div class="building"></div>
      <span class="verify-tag">${icon("verified")} ${listing.verified ? "Verified" : "Under review"}</span>
      ${landlordMode
        ? `<span class="status-tag">${esc(listing.status)}</span>`
        : `<button class="save-button ${listing.saved ? "saved" : ""}" data-action="save-listing" data-id="${listing.id}" aria-label="Save property">${icon("heart")}</button>`}
    </div>
    <div class="listing-info">
      <div class="listing-title-row"><h3>${esc(listing.title)}</h3><span class="rating">&#9733; 4.${7 + (listing.title.length % 3)}</span></div>
      <div class="listing-location">${icon("pin")} ${esc(listing.area)} &middot; ${esc(listing.university)}</div>
      <div class="listing-meta"><span>${listing.bedrooms} bed</span><span>${listing.bathrooms} bath</span><span>${esc(listing.type)}</span></div>
      <div class="listing-foot">
        <div class="listing-price">${money(listing.price)}<small>per academic year</small></div>
        <button class="icon-more" data-action="${landlordMode ? "edit-listing" : "view-listing"}" data-id="${listing.id}" aria-label="Open property">&rarr;</button>
      </div>
    </div>
  </article>`;
}

function roommateCard(person) {
  return `<article class="roommate-card glass">
    <div class="roommate-avatar">${initials(person.name)}</div>
    <div class="roommate-copy">
      <div><h3>${esc(person.name)}</h3><span>${person.score || 72}% match</span></div>
      <p>${esc(person.bio || "Verified student looking for a compatible co-living match.")}</p>
      <div class="amenities">${(person.habits || []).slice(0,3).map(habit=>`<span class="amenity">${esc(habit)}</span>`).join("")}<span class="amenity">${esc(person.university || "University")}</span></div>
    </div>
    <div class="roommate-actions"><button class="button subtle" data-action="view-roommate" data-id="${person.id}">Profile</button><button class="button primary" data-action="connect-roommate" data-id="${person.id}">Message</button></div>
  </article>`;
}

function tenantHome() {
  const universityListings = state.listings.filter(item => item.university === state.user.university);
  const visible = (universityListings.length ? universityListings : state.listings).slice(0,3);
  const savedCount = state.listings.filter(item => item.saved).length;
  const paidBookings = state.bookings.filter(item => item.status === "paid").length;
  return `
    <div class="hero-panel">
      <div class="hero-copy">
        <span class="eyebrow"><i class="live-dot"></i> ${esc(state.user.university)}</span>
        <h1>Good ${new Date().getHours()<12?"morning":new Date().getHours()<17?"afternoon":"evening"}, ${esc(firstName(state.user.name))}.</h1>
        <p>Find a verified home, connect with a compatible roommate, and handle the entire booking without leaving Offkay.</p>
        <div class="hero-actions"><button class="button primary" data-tab="explore">Explore homes &rarr;</button><button class="button subtle" data-action="open-matches">Find a roommate</button></div>
      </div>
      <div class="hero-visual"><div class="mini-property"><div class="mini-building"></div></div><div class="float-stat"><b>${visible.length || state.listings.length} nearby</b>verified places to explore</div></div>
    </div>
    <div class="metrics">
      <div class="metric glass"><div class="metric-top"><span>Saved homes</span><span class="metric-icon">${icon("heart")}</span></div><strong>${savedCount}</strong><small>Properties on your shortlist</small></div>
      <div class="metric glass"><div class="metric-top"><span>Conversations</span><span class="metric-icon">${icon("messages")}</span></div><strong>${state.conversations.length}</strong><small>Active landlord and roommate chats</small></div>
      <div class="metric glass"><div class="metric-top"><span>Confirmed bookings</span><span class="metric-icon">${icon("lock")}</span></div><strong>${paidBookings}</strong><small>Payments successfully completed</small></div>
    </div>
    <div class="section-head"><div><h2>Recommended near you</h2><p>Verified homes around your university and budget.</p></div><button class="link-button" data-tab="explore">View everything &rarr;</button></div>
    <div class="listing-grid">${visible.map(item => listingCard(item)).join("") || emptyState("No local homes yet","Try another university from the Explore tab.")}</div>`;
}

function landlordHome() {
  const mine = state.listings.filter(item => item.ownerId === state.user.id);
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
  $("#tab-home").innerHTML = state.user.role === "landlord" ? landlordHome() : tenantHome();
}

function propertyTable(items) {
  if (!items.length) return emptyState("No properties yet","Add your first property to start receiving student enquiries.",`<button class="button primary" data-action="new-listing">Add a property</button>`);
  return `<div class="property-table glass">
    <div class="property-row header"><span>Property</span><span>Annual rent</span><span>Type</span><span>Status</span><span></span></div>
    ${items.map(item=>`<div class="property-row">
      <div class="property-name"><span class="property-thumb"></span><span><b>${esc(item.title)}</b><span>${esc(item.area)}</span></span></div>
      <b>${money(item.price)}</b><span>${esc(item.type)}</span>
      <span class="table-status ${item.verified?"":"pending"}">${item.verified?"Published":"Under review"}</span>
      <button class="icon-more" data-action="edit-listing" data-id="${item.id}">&rarr;</button>
    </div>`).join("")}
  </div>`;
}

function filteredListings() {
  const query = state.filters.query.toLowerCase();
  return state.listings.filter(item => {
    const text = `${item.title} ${item.area} ${item.university}`.toLowerCase();
    return (!query || text.includes(query))
      && (!state.filters.university || item.university === state.filters.university)
      && (state.filters.type === "All" || item.type === state.filters.type)
      && (!state.filters.maxPrice || item.price <= Number(state.filters.maxPrice));
  });
}

function renderExplore() {
  const items = filteredListings();
  const tenant = state.user.role === "tenant";
  $("#tab-explore").innerHTML = `
    <div class="page-head"><div><span class="eyebrow">${tenant?"Student housing":"Your housing portfolio"}</span><h1>${tenant?"Find a place that works.":"Your houses, at a glance."}</h1><p>${tenant?"Search homes, roommates, inspections, and split rent from one quiet place.":"Publish a house, manage inspections, and answer students."}</p></div><div class="page-actions">${tenant?`<button class="button subtle" data-action="open-inspections">${icon("calendar")} Inspections</button>`:`<button class="button subtle" data-action="open-inspections">${icon("calendar")} Inspections</button><button class="button primary" data-action="new-listing">${icon("plus")} Add a house</button>`}</div></div>
    <div class="liquid-segment" aria-label="Explore view"><button class="${state.exploreMode==="homes"?"active":""}" data-action="explore-mode" data-mode="homes">Homes</button><button class="${state.exploreMode==="map"?"active":""}" data-action="explore-mode" data-mode="map">Map</button>${tenant?`<button class="${state.exploreMode==="roommates"?"active":""}" data-action="explore-mode" data-mode="roommates">Roommates</button>`:""}</div>
    <div class="filter-bar glass">
      <label class="filter-field"><span>&#8981;</span><input id="listingSearch" value="${esc(state.filters.query)}" placeholder="Area or property name"></label>
      <label class="filter-field"><span>&#8982;</span><select id="universityFilter"><option value="">All universities</option>${state.universities.map(name=>`<option ${state.filters.university===name?"selected":""}>${esc(name)}</option>`).join("")}</select></label>
      <label class="filter-field"><span>&#8358;</span><select id="priceFilter"><option value="">Any budget</option><option value="300000" ${state.filters.maxPrice==="300000"?"selected":""}>Under &#8358;300k</option><option value="500000" ${state.filters.maxPrice==="500000"?"selected":""}>Under &#8358;500k</option><option value="750000" ${state.filters.maxPrice==="750000"?"selected":""}>Under &#8358;750k</option></select></label>
      <button class="button primary" id="clearFilters">Reset</button>
    </div>
    <div class="filter-chips">${["All","Studio","Shared","En-suite"].map(type=>`<button class="chip ${state.filters.type===type?"active":""}" data-action="filter-type" data-type="${type}">${type}</button>`).join("")}</div>
    <div class="section-head"><div><h2>${state.exploreMode==="roommates" ? `${state.roommateCandidates.length} compatible roommates` : `${items.length} ${items.length===1?"home":"homes"} available`}</h2><p>${state.exploreMode==="roommates" ? "Filtered by university, budget, and lifestyle compatibility." : "Every published property is reviewed by Offkay."}</p></div></div>
    ${state.exploreMode==="roommates" ? `<div class="roommate-grid">${state.roommateCandidates.map(roommateCard).join("") || emptyState("No roommate matches yet","Update your budget and habits in Settings.")}</div>` : state.exploreMode==="map" ? mapCanvas(items) : `<div class="listing-grid">${items.map(item=>listingCard(item)).join("") || emptyState("Nothing matches those filters","Try widening your budget or selecting another university.")}</div>`}`;
}

function mapCanvas(items) {
  if (!items.length) return emptyState("No homes on this map","Try another area or filter.");
  return `<div class="map-canvas" aria-label="Approximate listing map">${items.map((item,index)=>{
    const left = 18 + ((index * 29) % 64);
    const top = 22 + ((index * 37) % 58);
    return `<button class="map-marker" style="left:${left}%;top:${top}%" data-action="view-listing" data-id="${item.id}" aria-label="Open ${esc(item.title)}">${index+1}</button>`;
  }).join("")}<div class="map-key">Approximate locations for safety · tap a pin for the home</div></div>`;
}

function conversationRow(conversation) {
  const active = state.activeConversation === conversation.id;
  return `<button class="conversation ${active?"active":""}" data-action="open-conversation" data-id="${conversation.id}">
    <span class="avatar">${initials(conversation.other?.name)}</span>
    <span class="conversation-text"><b>${esc(conversation.other?.name || "Offkay user")}</b><span>${esc(conversation.lastMessage?.text || "Start the conversation")}</span></span>
    <time>${conversation.lastMessage ? time(conversation.lastMessage.createdAt) : ""}</time>
  </button>`;
}

function renderMessages() {
  const current = state.conversations.find(item=>item.id===state.activeConversation);
  $("#tab-messages").innerHTML = `
    <div class="message-shell glass ${current?"chat-open":""}">
      <aside class="conversation-list">
        <h2>Messages</h2>
        <input class="conversation-search" id="conversationSearch" placeholder="Search conversations...">
        <div id="conversationRows">${state.conversations.map(conversationRow).join("") || emptyState("No messages yet","Contact a landlord or roommate to begin a conversation.")}</div>
      </aside>
      ${current ? chatMarkup(current) : `<div class="no-chat"><div><div class="empty-icon">&#9676;</div><b>Select a conversation</b><p>Your messages will appear here.</p></div></div>`}
    </div>`;
  if (current) loadMessages(current.id);
}

function chatMarkup(conversation) {
  return `<section class="chat">
    <header class="chat-head"><button class="icon-more mobile-chat-back" data-action="back-to-conversations">&larr;</button><span class="avatar">${initials(conversation.other?.name)}</span><span><b>${esc(conversation.other?.name)}</b><small>${conversation.other?.verified?"&#10003; Verified user":"Offkay member"}</small></span></header>
    <div class="chat-messages" id="chatMessages"><div class="no-chat">Loading messages...</div></div>
    <form class="chat-compose" id="messageForm"><input name="text" autocomplete="off" placeholder="Write a message..." required><button class="send-button" aria-label="Send">&uarr;</button></form>
  </section>`;
}

async function loadMessages(conversationId) {
  try {
    const data = await request(`/api/conversations/${conversationId}/messages`);
    if (state.activeConversation !== conversationId) return;
    state.messages = data.messages;
    const box = $("#chatMessages");
    if (!box) return;
    box.innerHTML = data.messages.map(message=>`<div class="bubble ${message.senderId===state.user.id?"mine":""}">${esc(message.text)}<time>${time(message.createdAt)}</time></div>`).join("") || `<div class="no-chat">No messages yet.</div>`;
    box.scrollTop = box.scrollHeight;
    const form = $("#messageForm");
    if (form) form.onsubmit = sendMessage;
  } catch (error) { toast(error.message); }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await request(`/api/conversations/${state.activeConversation}/messages`,{method:"POST",body:JSON.stringify({text})});
    await refreshData(false);
    state.activeConversation = state.activeConversation;
    renderMessages();
  } catch (error) { input.value = text; toast(error.message); }
}

function renderProfile() {
  const tenant = state.user.role === "tenant";
  const mine = state.listings.filter(item=>item.ownerId===state.user.id).length;
  const paid = state.bookings.filter(item=>item.status==="paid").length;
  const habits = ["Very tidy","Night owl","Early bird","Quiet home","Social","Non-smoker","Cooks often","Pet friendly"];
  $("#tab-profile").innerHTML = `
    <div class="page-head"><div><span class="eyebrow">Your account</span><h1>Profile & preferences</h1><p>Keep your details current so Offkay can work better for you.</p></div><div class="page-actions"><button class="button subtle" data-action="open-settings">${icon("settings")} Appearance</button></div></div>
    <div class="profile-grid">
      <aside class="profile-card glass">
        <span class="avatar large">${initials(state.user.name)}</span>
        <h2>${esc(state.user.name)}</h2><p>${esc(state.user.email)}</p>
        <span class="verified-line">${state.user.verified?"&#10003; Identity verified":"&#9676; Verification pending"}</span>
        <div class="profile-stats">
          <div class="profile-stat"><b>${tenant?state.listings.filter(item=>item.saved).length:mine}</b><span>${tenant?"SAVED HOMES":"PROPERTIES"}</span></div>
          <div class="profile-stat"><b>${paid}</b><span>CONFIRMED</span></div>
        </div>
      </aside>
      <form class="profile-form glass form-stack" id="profileForm">
        <h2>Personal details</h2><p>${tenant?"Your university and habits are used for roommate recommendations.":"These details appear on your verified property profile."}</p>
        <div class="two-fields"><label>Full name<input name="name" value="${esc(state.user.name)}" required></label><label>Phone number<input name="phone" value="${esc(state.user.phone || "")}"></label></div>
        <label>University<select name="university">${state.universities.map(name=>`<option ${state.user.university===name?"selected":""}>${esc(name)}</option>`).join("")}</select></label>
        <label>About you<textarea name="bio" placeholder="${tenant?"Tell potential roommates a little about yourself":"Tell students about your experience and properties"}">${esc(state.user.bio || "")}</textarea></label>
        ${tenant?`<label>Maximum annual budget<input name="budget" type="number" min="0" step="10000" value="${state.user.budget || ""}" placeholder="500000"></label>
        <label>Lifestyle preferences<div class="habit-picker">${habits.map(habit=>`<button type="button" class="habit ${(state.user.habits||[]).includes(habit)?"selected":""}" data-action="toggle-habit" data-habit="${habit}">${habit}</button>`).join("")}</div></label>`:""}
        <button class="button primary" type="submit">Save profile changes</button>
      </form>
    </div>`;
  $("#profileForm").onsubmit = saveProfile;
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
    state.user = data.user; enterApp(); switchTab("profile"); toast("Profile updated");
  } catch(error) { toast(error.message); }
  finally { setLoading(button,false); }
}

function settingsSheet() {
  const themes = [
    {id:"offkay",name:"Offkay",note:"Brand default",colors:["#FAFAFA","#344E67","#80DBEE","#FF7F6D"]},
    {id:"slate",name:"Slate",note:"Cool and quiet",colors:["#F0F2F5","#39586E","#E4EBF0","#3C7564"]},
    {id:"clay",name:"Clay",note:"Warm and grounded",colors:["#F6F1EC","#9A5F48","#F0DED2","#537256"]},
    {id:"midnight",name:"Midnight",note:"Low-light viewing",colors:["#181B20","#8DBFAC","#303B43","#F08A87"]}
  ];
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Appearance</span><h2>Choose a palette</h2><p>Each palette preserves Offkay’s contrast, safety states, and housing-first hierarchy.</p></div><button class="close-button">&times;</button></div>
    <div class="settings-stack">
      <button class="settings-row" data-action="open-verification">${icon("verified")} <span><b>Manual verification</b><small>NIN, ID card, and student/host document</small></span><em>${esc(state.verification?.status || state.user.verificationStatus || "not submitted")}</em></button>
      ${state.user.role === "tenant" ? `<button class="settings-row" data-action="activate-host">${icon("home")} <span><b>Become a host</b><small>Switch to host mode and publish verified houses</small></span><em>Airbnb-style</em></button>` : `<button class="settings-row" data-action="new-listing">${icon("plus")} <span><b>Add a house</b><small>Landlord-only listing creation</small></span><em>Host</em></button>`}
    </div>
    <div class="theme-grid">${themes.map(theme=>`<button class="theme-choice ${state.theme===theme.id?"active":""}" data-action="set-theme" data-theme="${theme.id}"><span class="theme-swatches">${theme.colors.map(color=>`<i style="background:${color}"></i>`).join("")}</span><b>${theme.name}</b><small>${theme.note}</small></button>`).join("")}</div>
    <div class="payment-note">Offkay is the default brand theme. Your preference is saved on this device.</div>`);
}

function verificationSheet() {
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Manual verification</span><h2>Verify your Offkay identity</h2><p>Submit your NIN and ID documents. Offkay reviews this manually before approval.</p></div><button class="close-button">&times;</button></div>
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
  modal(`<div class="modal-head"><div><span class="eyebrow">Become a host</span><h2>Start hosting on Offkay</h2><p>You’ll switch into host mode so you can publish houses, manage inspections, and receive verified student enquiries.</p></div><button class="close-button">&times;</button></div><button class="button primary wide" id="activateHostButton">${icon("home")} Continue as host</button>`);
  $("#activateHostButton").onclick = async event => {
    setLoading(event.currentTarget,true,"Switching…");
    try {
      const data = await request("/api/host/activate",{method:"POST"});
      state.user = data.user; await refreshData(false); closeModal(); enterApp(); switchTab("explore"); toast("Host mode activated");
    } catch(error) { toast(error.message); }
  };
}

function emptyState(title, description, action = "") {
  return `<div class="empty-state glass"><div class="empty-icon">&#8962;</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
}

function openListing(id) {
  const item = state.listings.find(listing=>listing.id===id);
  if (!item) return;
  const photo = item.photos?.[0];
  modal(`
    <div class="modal-head"><div><span class="eyebrow">${item.verified?"&#10003; Verified property":"&#9676; Verification pending"}</span></div><button class="close-button">&times;</button></div>
    <div class="listing-detail">
      <div class="detail-image">${photo ? `<img src="${photo}" alt="${esc(item.title)}">` : `<div class="building"></div>`}<span class="map-pin">⌖ ${esc(item.area)}</span></div>
      <div class="detail-copy">
        <span class="eyebrow">${esc(item.type)}</span><h2>${esc(item.title)}</h2><span>&#8982; ${esc(item.area)} &middot; ${esc(item.university)}</span>
        <div class="detail-price">${money(item.price)} <small>/ academic year</small></div>
        <p>${esc(item.description)}</p>
        <div class="amenities">${item.amenities.map(name=>`<span class="amenity">&#10003; ${esc(name)}</span>`).join("")}</div>
        <div class="detail-actions">
          <a class="button subtle" href="${mapUrl(item)}" target="_blank" rel="noreferrer">View on map</a>
          <button class="button subtle" data-action="contact-landlord" data-id="${item.id}">Message</button>
          <button class="button primary" data-action="open-inspection" data-id="${item.id}">Request inspection</button>
          <button class="button primary" data-action="start-booking" data-id="${item.id}">Book & split rent</button>
        </div>
        <button class="report-link" data-action="open-report" data-id="${item.id}">Report a concern</button>
      </div>
    </div>`,true);
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
      <fieldset class="segmented"><legend>Time window</legend><label><input type="radio" name="timeWindow" value="Morning" checked><span>Morning</span></label><label><input type="radio" name="timeWindow" value="Afternoon"><span>Afternoon</span></label><label><input type="radio" name="timeWindow" value="Evening"><span>Evening</span></label></fieldset>
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
  modal(`
    <div class="modal-head"><div><span class="eyebrow">Inspections</span><h2>${state.user.role==="landlord"?"Tour requests":"Your requests"}</h2><p>${state.user.role==="landlord"?"Students who want to inspect one of your houses.":"Inspection requests you have sent to landlords."}</p></div><button class="close-button">&times;</button></div>
    <div class="inspection-list">${items.length ? items.map(inspection=>{
      const listing = state.listings.find(item=>item.id===inspection.listingId);
      return `<div class="inspection-row"><span class="metric-icon">${icon("calendar")}</span><span><b>${esc(listing?.title || "House inspection")}</b><small>${esc(inspection.preferredDate || "Date pending")} &middot; ${esc(inspection.timeWindow)} &middot; ${esc(inspection.status)}</small></span></div>`;
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

function startBooking(id) {
  const item = state.listings.find(listing=>listing.id===id);
  if (!item) return;
  modal(`
    <div class="modal-head"><div><h2>Secure your space</h2><p>Review the booking before continuing to payment.</p></div><button class="close-button">&times;</button></div>
    <div class="checkout-card"><div class="checkout-thumb"></div><div><b>${esc(item.title)}</b><span>${esc(item.area)} &middot; ${esc(item.university)}</span><span style="color:var(--green);font-weight:800">&#10003; Property and owner reviewed</span></div></div>
    <div class="cost-row"><span>Annual rent</span><b>${money(item.price)}</b></div>
    <fieldset class="segmented split-segment"><legend>How would you like to pay?</legend><label><input type="radio" name="splitCount" value="1" checked><span>Pay alone</span></label><label><input type="radio" name="splitCount" value="2"><span>Split 2 ways</span></label><label><input type="radio" name="splitCount" value="3"><span>Split 3 ways</span></label></fieldset>
    <div class="cost-row"><span>Offkay fee</span><b>&#8358;0 launch offer</b></div>
    <div class="cost-row"><span>Payment protection</span><b>Included</b></div>
    <div class="cost-row total"><span>Total</span><span>${money(item.price)}</span></div>
    <div class="payment-note">This MVP uses a test confirmation flow. Live collection requires a Paystack merchant key and server-side transaction verification before launch.</div>
    <button class="button primary wide" id="createBooking" data-id="${item.id}">Continue to secure payment &rarr;</button>`);
  $("#createBooking").onclick = createBooking;
}

async function createBooking(event) {
  const button=event.currentTarget; setLoading(button,true,"Creating booking...");
  try {
    const splitCount = Number(document.querySelector("input[name=splitCount]:checked")?.value || 1);
    const data = await request("/api/bookings",{method:"POST",body:JSON.stringify({listingId:button.dataset.id,splitCount})});
    showPayment(data.booking);
  } catch(error) { toast(error.message); setLoading(button,false); }
}

function showPayment(booking) {
  modal(`
    <div class="modal-head"><div><h2>Test payment</h2><p>Use this step to validate the complete booking journey.</p></div><button class="close-button">&times;</button></div>
    <div class="checkout-card"><div class="checkout-thumb"></div><div><b>Booking ${esc(booking.id.slice(-8).toUpperCase())}</b><span>Amount due now</span></div></div>
    <div class="cost-row"><span>${booking.splitCount > 1 ? `Your share (${booking.splitCount} people)` : "Your payment"}</span><b>${money(booking.amount / booking.splitCount)}</b></div>
    <div class="cost-row total"><span>Booking total</span><span>${money(booking.amount)}</span></div>
    <div class="payment-note">No bank card will be charged in MVP mode. Clicking below records a successful test transaction and unlocks the post-payment booking state.</div>
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
  if (state.user.role !== "tenant") return listingForm();
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
        <div class="match-info"><span>${esc(match.university)}</span><h2>${esc(match.name)}</h2><p>${esc(match.bio || "A verified student looking for a compatible roommate near campus.")}</p>
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
    <div class="modal-head"><div><span class="eyebrow">${match.score || 72}% match</span><h2>${esc(match.name)}</h2><p>${esc(match.university || "Verified student")}</p></div><button class="close-button">&times;</button></div>
    <div class="match-card">
      <div class="match-person"><span class="match-score">${match.score || 72}% match</span></div>
      <div class="match-info">
        <h2>${esc(firstName(match.name))}'s profile</h2>
        <p>${esc(match.bio || "Student looking for a compatible roommate cluster.")}</p>
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
    if (auth) return setAuthMode(auth.dataset.authMode);
    const role = event.target.closest("[data-role]");
    if (role) {
      $$(".role-option").forEach(item=>item.classList.toggle("active",item===role));
      $("#signupForm [name=role]").value=role.dataset.role;
      return;
    }
    const demo = event.target.closest("[data-demo]");
    if (demo) {
      const landlord=demo.dataset.demo==="landlord";
      $("#loginForm [name=email]").value=landlord?"landlord@demo.test":"tenant@demo.test";
      $("#loginForm [name=password]").value="demo1234";
      $("#loginForm").requestSubmit();
      return;
    }
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return;
    const {action,id} = actionNode.dataset;
    if (action==="view-listing") openListing(id);
    if (action==="save-listing") saveListingToggle(id);
    if (action==="new-listing") listingForm();
    if (action==="edit-listing") listingForm(state.listings.find(item=>item.id===id));
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
    if (action==="open-settings") settingsSheet();
    if (action==="open-verification") verificationSheet();
    if (action==="activate-host") activateHost();
    if (action==="set-theme") {applyTheme(actionNode.dataset.theme);settingsSheet();}
    if (action==="explore-mode") {state.exploreMode=actionNode.dataset.mode;renderExplore();}
    if (action==="finish-payment") {closeModal();switchTab("home");renderHome();toast("Booking confirmed");}
    if (action==="filter-type") {state.filters.type=actionNode.dataset.type;renderExplore();}
    if (action==="open-conversation") {state.activeConversation=id;renderMessages();}
    if (action==="back-to-conversations") {state.activeConversation=null;renderMessages();}
    if (action==="toggle-habit") actionNode.classList.toggle("selected");
  });

  $("#modalRoot").addEventListener("click", event => { if(event.target===$("#modalRoot")) closeModal(); });
  $("#loginForm").addEventListener("submit", login);
  $("#signupForm").addEventListener("submit", signup);
  $("#logoutButton").addEventListener("click", logout);
  $("#globalSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      state.filters.query=event.currentTarget.value;switchTab("explore");renderExplore();
    }
  });
  document.addEventListener("keydown",event=>{
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();$("#globalSearch").focus();}
    if(event.key==="Escape")closeModal();
  });
  document.addEventListener("input",event=>{
    if(event.target.id==="listingSearch"){state.filters.query=event.target.value;clearTimeout(renderExplore.timer);renderExplore.timer=setTimeout(renderExplore,180);}
    if(event.target.id==="universityFilter"){state.filters.university=event.target.value;renderExplore();}
    if(event.target.id==="priceFilter"){state.filters.maxPrice=event.target.value;renderExplore();}
    if(event.target.id==="conversationSearch"){
      const query=event.target.value.toLowerCase();
      $("#conversationRows").innerHTML=state.conversations.filter(item=>item.other?.name.toLowerCase().includes(query)).map(conversationRow).join("");
    }
  });
  document.addEventListener("click",event=>{
    if(event.target.id==="clearFilters"){state.filters={query:"",university:"",type:"All",maxPrice:""};renderExplore();}
  });
}

async function login(event) {
  event.preventDefault();
  const button=event.submitter;setLoading(button,true,"Signing in...");
  try {
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const data=await request("/api/auth/login",{method:"POST",body:JSON.stringify(values)});
    state.user=data.user;await refreshData(false);enterApp();toast(`Welcome back, ${firstName(state.user.name)}`);
  } catch(error){toast(error.message)}
  finally{setLoading(button,false)}
}

async function signup(event) {
  event.preventDefault();
  const button=event.submitter;setLoading(button,true,"Creating account...");
  try {
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const data=await request("/api/auth/signup",{method:"POST",body:JSON.stringify(values)});
    state.user=data.user;await refreshData(false);enterApp();toast("Your Offkay account is ready");
  } catch(error){toast(error.message)}
  finally{setLoading(button,false)}
}

async function logout() {
  try { await request("/api/auth/logout",{method:"POST"}); }
  finally {
    state.user=null;state.activeTab="home";state.activeConversation=null;showAuth();setAuthMode("login");toast("Signed out");
  }
}

bindEvents();
bootstrap();
