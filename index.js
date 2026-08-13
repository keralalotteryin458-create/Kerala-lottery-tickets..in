functions/index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Region configuration for India (Mumbai)
const REGION = "asia-south1";

/**
 1. Process Order & Lock Tickets
*/
exports.processOrderAndVerify = functions.region(REGION).https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { ticketIds, utr } = data;

    if (!utr || typeof utr !== "string" || !/^\d{12}$/.test(utr)) {
        throw new functions.https.HttpsError("invalid-argument", "Valid 12-digit numeric UTR required.");
    }

    if (!ticketIds || !Array.isArray(ticketIds) || ticketIds.length === 0 || ticketIds.length > 10) {
        throw new functions.https.HttpsError("invalid-argument", "Select between 1 and 10 tickets.");
    }

    const uniqueTicketIds = [...new Set(ticketIds)];
    if (uniqueTicketIds.length !== ticketIds.length) {
        throw new functions.https.HttpsError("invalid-argument", "Duplicate ticket IDs detected.");
    }

    // Rate limit: Max 3 pending orders per user
    const pendingOrders = await db.collection("orders")
        .where("userId", "==", context.auth.uid)
        .where("status", "==", "PENDING_VERIFICATION")
        .get();

    if (pendingOrders.size >= 3) {
        throw new functions.https.HttpsError("resource-exhausted", "Maximum 3 pending orders allowed.");
    }

    return await db.runTransaction(async (transaction) => {
        const utrRef = db.collection("processed_utrs").doc(utr);
        const utrDoc = await transaction.get(utrRef);

        if (utrDoc.exists) {      
            throw new functions.https.HttpsError("already-exists", "This UTR has already been submitted.");      
        }      

        let calculatedTotal = 0;      
        const ticketsToUpdate = [];      

        for (const id of uniqueTicketIds) {      
            const ticketRef = db.collection("tickets").doc(id);      
            const ticketDoc = await transaction.get(ticketRef);      

            if (!ticketDoc.exists) {      
                throw new functions.https.HttpsError("not-found", `Ticket ${id} not found.`);      
            }      

            const ticketData = ticketDoc.data();      

            if (ticketData.isSold || ticketData.status === "SOLD" || ticketData.status === "RESERVED") {      
                throw new functions.https.HttpsError("failed-precondition", `Ticket ${ticketData.number || id} is unavailable.`);      
            }      

            const price = Number(ticketData.price || 0);      
            if (isNaN(price) || price <= 0) {      
                throw new functions.https.HttpsError("invalid-argument", `Invalid price for ticket ${id}.`);      
            }      

            calculatedTotal += price;      
            ticketsToUpdate.push({      
                ref: ticketRef,      
                id: id,      
                number: String(ticketData.number || id),      
                price: price,      
                name: String(ticketData.name || "Kerala Lottery")      
            });      
        }      

        transaction.set(utrRef, {      
            userId: context.auth.uid,      
            createdAt: admin.firestore.FieldValue.serverTimestamp()      
        });      

        ticketsToUpdate.forEach(item => {      
            transaction.update(item.ref, {      
                status: "RESERVED",      
                reservedBy: context.auth.uid,      
                reservedAt: admin.firestore.FieldValue.serverTimestamp()      
            });      
        });      

        const newOrderRef = db.collection("orders").doc();      
        transaction.set(newOrderRef, {      
            userId: context.auth.uid,      
            tickets: ticketsToUpdate.map(item => ({ id: item.id, number: item.number, price: item.price, name: item.name })),      
            amount: calculatedTotal,      
            utr: utr,      
            status: "PENDING_VERIFICATION",      
            createdAt: admin.firestore.FieldValue.serverTimestamp()      
        });      

        return {      
            success: true,      
            orderId: newOrderRef.id,      
            amount: calculatedTotal,      
            message: "Order placed successfully. Awaiting payment verification."      
        };
    });
});

/**
 2. Admin Approve / Reject Order with Audit Logging
*/
exports.approveOrRejectOrder = functions.region(REGION).https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "Authentication required.");
    }

    const adminDoc = await db.collection("admins").doc(context.auth.uid).get();    
    if (!adminDoc.exists) {    
        throw new functions.https.HttpsError("permission-denied", "Only administrators can perform this action.");    
    }    

    const { orderId, action } = data;    
    if (!orderId || !["APPROVE", "REJECT"].includes(action)) {    
        throw new functions.https.HttpsError("invalid-argument", "Invalid arguments provided.");    
    }    

    return await db.runTransaction(async (transaction) => {    
        const orderRef = db.collection("orders").doc(orderId);    
        const orderDoc = await transaction.get(orderRef);    

        if (!orderDoc.exists) {      
            throw new functions.https.HttpsError("not-found", "Order not found.");      
        }      

        const orderData = orderDoc.data();      
        if (orderData.status !== "PENDING_VERIFICATION") {      
            throw new functions.https.HttpsError("failed-precondition", "Order has already been processed or expired.");      
        }      

        const isApprove = action === "APPROVE";      
        const utrRef = db.collection("processed_utrs").doc(orderData.utr);      

        for (const ticketItem of orderData.tickets) {      
            const ticketRef = db.collection("tickets").doc(ticketItem.id);      
            const currentTicket = await transaction.get(ticketRef);      

            if (!currentTicket.exists || currentTicket.data().status !== "RESERVED") {      
                throw new functions.https.HttpsError("failed-precondition", `Ticket state for ${ticketItem.id} has changed.`);      
            }      

            if (isApprove) {      
                transaction.update(ticketRef, {      
                    status: "SOLD",      
                    isSold: true,      
                    soldTo: orderData.userId,      
                    soldAt: admin.firestore.FieldValue.serverTimestamp()      
                });      
            } else {      
                transaction.update(ticketRef, {      
                    status: "AVAILABLE",      
                    isSold: false,      
                    reservedBy: admin.firestore.FieldValue.delete(),      
                    reservedAt: admin.firestore.FieldValue.delete()      
                });      
            }      
        }      

        if (!isApprove) {      
            transaction.delete(utrRef);      
        }      

        transaction.update(orderRef, {      
            status: isApprove ? "VERIFIED" : "REJECTED",      
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),      
            verifiedBy: context.auth.uid      
        });      

        const logRef = db.collection("admin_logs").doc();      
        transaction.set(logRef, {      
            action: action,      
            orderId: orderId,      
            adminId: context.auth.uid,      
            timestamp: admin.firestore.FieldValue.serverTimestamp()      
        });      

        return { success: true, message: `Order ${isApprove ? "Approved" : "Rejected"} successfully.` };    
    });
});

/**
 3. Scheduled Clean Up: Release Expired Reservations (Every 15 mins)
*/
exports.releaseExpiredReservations = functions.region(REGION).pubsub.schedule("every 15 minutes").onRun(async (context) => {
    const cutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 30 * 60 * 1000));

    const expiredTickets = await db.collection("tickets")    
        .where("status", "==", "RESERVED")    
        .where("reservedAt", "<=", cutoff)    
        .get();    

    if (expiredTickets.empty) return null;    

    const expiredOrders = await db.collection("orders")    
        .where("status", "==", "PENDING_VERIFICATION")    
        .where("createdAt", "<=", cutoff)    
        .get();    

    const batch = db.batch();    

    expiredTickets.forEach(doc => {    
        batch.update(doc.ref, {    
            status: "AVAILABLE",    
            isSold: false,    
            reservedBy: admin.firestore.FieldValue.delete(),    
            reservedAt: admin.firestore.FieldValue.delete()    
        });    
    });    

    expiredOrders.forEach(doc => {    
        const data = doc.data();    
        batch.update(doc.ref, { status: "EXPIRED" });    
        if (data.utr) {    
            batch.delete(db.collection("processed_utrs").doc(data.utr));    
        }    
    });    

    await batch.commit();    
    console.log(`Cleaned up ${expiredTickets.size} tickets and ${expiredOrders.size} orders.`);    
    return null;
  index.html
<script>  
const firebaseConfig = {  
    apiKey: "YOUR_API_KEY",  
    authDomain: "YOUR_PROJECT.firebaseapp.com",  
    projectId: "YOUR_PROJECT_ID",  
    storageBucket: "YOUR_PROJECT.appspot.com",  
    messagingSenderId: "YOUR_SENDER_ID",  
    appId: "YOUR_APP_ID"  
};  
  
firebase.initializeApp(firebaseConfig);      
const db = firebase.firestore();      
const auth = firebase.auth();      

// Initialize functions with the correct target region
const regionalFunctions = firebase.app().functions('asia-south1');      
  
const UPI_ID = "pankaj.k17830@ptaxis";      
let selectedTickets = [];      
let allTicketsData = [];    
  
// Authenticate anonymously on load    
auth.onAuthStateChanged(async (user) => {      
    if (!user) {      
        try {      
            await auth.signInAnonymously();      
        } catch (e) {      
            console.error("Auth Error:", e);      
        }      
        return;      
    }      
  
    // Check if user is admin    
    try {
        const adminDoc = await db.collection("admins").doc(user.uid).get();      
        if (adminDoc.exists) {      
            document.getElementById("toggleAdminBtn").style.display = "block";      
            loadAdminOrders();      
        }
    } catch (err) {
        console.warn("Non-admin user signed in:", err.message);
    }
  
    initTicketListener();    
});      
  
// Real-time listener for available tickets    
function initTicketListener() {    
    db.collection("tickets").onSnapshot((snapshot) => {    
        const grid = document.getElementById("ticketGrid");    
        grid.innerHTML = "";    
        allTicketsData = [];    
  
        snapshot.forEach((doc) => {    
            const data = doc.id ? { id: doc.id, ...doc.data() } : null;    
            if (!data) return;    
            allTicketsData.push(data);    
  
            let cardClass = "ticket-card";    
            if (data.status === "SOLD" || data.isSold) cardClass += " sold";    
            else if (data.status === "RESERVED") cardClass += " reserved";    
            else if (selectedTickets.includes(data.id)) cardClass += " selected";    
  
            const card = document.createElement("div");    
            card.id = `ticket-${data.id}`;  
            card.className = cardClass;    
            card.onclick = () => toggleTicketSelection(data.id, card);    
            card.innerHTML = `      
                <span class="ticket-name">${data.name || "Kerala Lottery"}</span>      
                <span class="ticket-number">${data.number}</span>      
                <span class="ticket-price">₹${data.price}</span>      
            `;    
            grid.appendChild(card);    
        });    
        updateBottomBar();    
    }, (error) => {
        console.error("Ticket listener failed:", error);
    });    
}    
  
function toggleTicketSelection(id, cardElement) {    
    const index = selectedTickets.indexOf(id);    
  
    if (index > -1) {    
        selectedTickets.splice(index, 1);    
        if (cardElement) cardElement.classList.remove("selected");  
    } else {    
        if (selectedTickets.length >= 10) {    
            alert("Maximum 10 tickets can be selected at once.");    
            return;    
        }    
        selectedTickets.push(id);    
        if (cardElement) cardElement.classList.add("selected");  
    }    
  
    updateBottomBar();  
}    
  
function updateBottomBar() {    
    document.getElementById("ticketCountText").innerText = selectedTickets.length;    
    const total = selectedTickets.reduce((sum, id) => {    
        const t = allTicketsData.find(item => item.id === id);    
        return sum + (t ? Number(t.price) : 0);    
    }, 0);    
    document.getElementById("totalAmountText").innerText = `TOTAL: ₹${total}`;    
}    
  
// Modal Handling    
const modal = document.getElementById("paymentModal");    
document.getElementById("btnProceed").onclick = () => {    
    if (selectedTickets.length === 0) {    
        alert("Please select at least one ticket.");    
        return;    
    }    
      
    document.getElementById("upiIdText").innerText = UPI_ID;  
      
    const total = selectedTickets.reduce((sum, id) => {    
        const t = allTicketsData.find(item => item.id === id);    
        return sum + (t ? Number(t.price) : 0);    
    }, 0);    
        
    // Setup UPI intent link    
    document.getElementById("payDirectBtn").href = `upi://pay?pa=${UPI_ID}&pn=Kerala%20Lottery&am=${total}&cu=INR`;    
    modal.style.display = "flex";    
};    
  
document.getElementById("btnCloseModal").onclick = () => { modal.style.display = "none"; };    
document.getElementById("btnCopyUpi").onclick = () => {    
    navigator.clipboard.writeText(UPI_ID);    
    alert("UPI ID copied to clipboard!");    
};    
  
// Submit Order & UTR    
document.getElementById("btnWaSubmit").onclick = async () => {    
    const utr = document.getElementById("utrInput").value.trim();    
    if (!/^\d{12}$/.test(utr)) {    
        alert("Please enter a valid 12-digit UTR reference number.");    
        return;    
    }    
  
    const btn = document.getElementById("btnWaSubmit");    
    btn.disabled = true;    
    btn.innerText = "Processing...";    
  
    try {    
        // Call regional function explicitly
        const processOrderAndVerify = regionalFunctions.httpsCallable("processOrderAndVerify");    
        const result = await processOrderAndVerify({ ticketIds: selectedTickets, utr: utr });    
        
        alert(result.data.message);    
        modal.style.display = "none";    
        selectedTickets = [];    
        document.getElementById("utrInput").value = "";    
        
        // Remove selection state from grid elements
        document.querySelectorAll(".ticket-card.selected").forEach(el => el.classList.remove("selected"));
        updateBottomBar();  
    } catch (error) {    
        alert("Error: " + error.message);    
    } finally {    
        btn.disabled = false;    
        btn.innerText = "📲 Verify & Confirm Payment";    
    }    
};    
  
// Admin Toggle & Management    
document.getElementById("toggleAdminBtn").onclick = () => {    
    const panel = document.getElementById("adminPanel");    
    panel.style.display = panel.style.display === "block" ? "none" : "block";    
};    
  
function loadAdminOrders() {    
    db.collection("orders").where("status", "==", "PENDING_VERIFICATION").onSnapshot((snapshot) => {    
        const tbody = document.getElementById("ordersTableBody");    
        tbody.innerHTML = "";    
        if (snapshot.empty) {    
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No pending orders.</td></tr>`;    
            return;    
        }    
        snapshot.forEach(doc => {    
            const order = doc.data();    
            const tr = document.createElement("tr");    
            tr.innerHTML = `      
                <td>${doc.id}</td>      
                <td>${order.tickets ? order.tickets.map(t => t.number).join(", ") : "N/A"}</td>      
                <td>₹${order.amount}</td>      
                <td>${order.utr}</td>      
                <td>${order.status}</td>      
                <td>      
                    <button class="btn-action btn-approve" onclick="handleAdminAction('${doc.id}', 'APPROVE')">Approve</button>      
                    <button class="btn-action btn-reject" onclick="handleAdminAction('${doc.id}', 'REJECT')">Reject</button>      
                </td>      
            `;    
            tbody.appendChild(tr);    
        });    
    });    
}    
  
async function handleAdminAction(orderId, action) {    
    if (!confirm(`Are you sure you want to ${action.toLowerCase()} this order?`)) return;    
    try {    
        // Call regional function explicitly
        const approveOrRejectOrder = regionalFunctions.httpsCallable("approveOrRejectOrder");    
        const res = await approveOrRejectOrder({ orderId, action });    
        alert(res.data.message);    
    } catch (err) {    
        alert("Action failed: " + err.message);    
    }    
}  
</script>
});

firebase deploy --only firestore:rules
firebase deploy --only functions
