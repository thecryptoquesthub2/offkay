const $ = selector => document.querySelector(selector);
let token = sessionStorage.getItem("offkay-admin-token") || "";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

const naira = value => `₦${Number(value || 0).toLocaleString("en-NG")}`;

function statCard(label, value) {
  return `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
}

function verificationCard(v) {
  return `<div class="card" data-vid="${v.id}">
    <div class="row">
      <div class="who">
        <b>${v.applicantName} <span class="tag ${v.statusLabel === "PENDING" ? "pending" : ""}">${v.statusLabel === "PENDING" ? "PENDING — under review" : (v.statusLabel || "PENDING")}</span></b>
        <small>${v.applicantName} · ${v.applicantEmail} · ${v.applicantRole}</small>
        <small>Submitted ${new Date(v.createdAt).toLocaleString()} · status: ${v.status}</small>
        <small>NIN: <code>${v.ninMasked}</code> · ID type: ${v.idType}</small>
      </div>
      <div class="actions">
        ${v.hasIdCard ? `<button class="btn secondary" data-doc="idCard">View ID document</button>` : `<span class="muted">No ID document</span>`}
        ${v.hasSupportDocument ? `<button class="btn secondary" data-doc="support">View supporting doc</button>` : ""}
        <button class="btn" data-decision="approve">Approve ✓</button>
        <button class="btn danger" data-decision="reject">Reject</button>
      </div>
    </div>
    <div class="doc-slot"></div>
    <div class="reject-slot"></div>
  </div>`;
}

function listingCard(l) {
  return `<div class="card">
    <div class="row">
      <div class="who"><b>${l.title}</b><small>${l.ownerName || ""} · ${l.area} · ${l.university} · ${naira(l.price)}/yr · ${l.status}</small></div>
      <div class="actions">
        <button class="btn" data-listing="${l.id}" data-verify="1">Verify ✓</button>
        <button class="btn danger" data-listing="${l.id}" data-verify="0">Suspend</button>
      </div>
    </div>
  </div>`;
}

function reportCard(r) {
  return `<div class="card">
    <div class="row">
      <div class="who"><b>${r.category}</b><small>Listing ${r.listingId} · reported by ${r.reporterName} · ${new Date(r.createdAt).toLocaleString()}</small><small>${r.detail}</small></div>
    </div>
  </div>`;
}

function userRow(u) {
  return `<div class="card"><div class="row">
    <div class="who"><b>${u.name}</b><small>${u.email} · ${u.role} · ${u.university}</small></div>
    <span class="tag ${u.verified ? "verified" : ""}">${u.verified ? "verified" : "unverified"}</span>
  </div></div>`;
}

async function load() {
  try {
    const data = await api("/api/admin/overview");
    $("#lock").classList.add("hidden");
    $("#console").classList.remove("hidden");
    sessionStorage.setItem("offkay-admin-token", token);
    const s = data.stats;
    $("#stats").innerHTML = [
      statCard("Users", s.users), statCard("Tenants", s.tenants), statCard("Landlords", s.landlords),
      statCard("Listings", s.listings), statCard("Pending verifications", s.pendingVerifications),
      statCard("Unverified listings", s.pendingListings), statCard("Open reports", s.openReports)
    ].join("");
    $("#verifications").innerHTML = data.verifications.length
      ? data.verifications.map(verificationCard).join("")
      : `<div class="empty">No verification requests waiting. 🎉</div>`;
    $("#listings").innerHTML = data.listings.length ? data.listings.map(listingCard).join("") : `<div class="empty">All properties are verified. ✓</div>`;
    $("#reports").innerHTML = data.reports.length ? data.reports.map(reportCard).join("") : `<div class="empty">No safety reports.</div>`;
    $("#users").innerHTML = data.users.slice(-20).reverse().map(userRow).join("");
    bindReviewActions();
  } catch (err) {
    if (String(err.message).includes("token")) {
      sessionStorage.removeItem("offkay-admin-token");
      token = "";
      $("#lock").classList.remove("hidden");
      $("#console").classList.add("hidden");
    }
    console.error(err);
  }
}

function bindReviewActions() {
  document.querySelectorAll("[data-decision]").forEach(button => {
    button.onclick = async () => {
      const card = button.closest("[data-vid]");
      const id = card.dataset.vid;
      const decision = button.dataset.decision;
      let reason = "";
      if (decision === "reject") {
        reason = prompt("Reason for rejection (shown to the user):");
        if (!reason) return;
      }
      button.disabled = true;
      try {
        await api(`/api/admin/verification/${id}/review`, { method: "POST", body: JSON.stringify({ decision, reason }) });
        card.remove();
        load();
      } catch (err) { alert(err.message); button.disabled = false; }
    };
  });
  document.querySelectorAll("[data-doc]").forEach(button => {
    button.onclick = () => {
      const card = button.closest("[data-vid]");
      const slot = card.querySelector(".doc-slot");
      const kind = button.dataset.doc;
      if (slot.dataset.open === kind) { slot.innerHTML = ""; slot.dataset.open = ""; return; }
      slot.innerHTML = `<img class="doc-view" src="/api/admin/verification/${card.dataset.vid}/document/${kind}?t=${Date.now()}" alt="Document">`;
      slot.dataset.open = kind;
    };
  });
  document.querySelectorAll("[data-listing]").forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/listing/${button.dataset.listing}/verify`, { method: "POST", body: JSON.stringify({ decision: button.dataset.verify === "1" ? "approve" : "reject" }) });
        load();
      } catch (err) { alert(err.message); button.disabled = false; }
    };
  });
}

$("#tokenForm").addEventListener("submit", event => {
  event.preventDefault();
  token = $("#tokenInput").value.trim();
  load();
});
$("#refreshButton").addEventListener("click", load);
$("#lockButton").addEventListener("click", () => {
  sessionStorage.removeItem("offkay-admin-token");
  token = "";
  $("#console").classList.add("hidden");
  $("#lock").classList.remove("hidden");
});

if (token) load();
