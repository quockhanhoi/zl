async function fetchData(endpoint) {
    try {
        const response = await fetch(`/api/${endpoint}`);
        return await response.json();
    } catch (error) {
        console.error(`Error fetching ${endpoint}:`, error);
        return null;
    }
}

async function updateStatus() {
    const status = await fetchData('status');
    if (status) {
        document.getElementById('uptime').textContent = status.uptime;
        document.getElementById('memory').textContent = status.memory;
        document.getElementById('total-commands').textContent = status.commands;
        document.getElementById('total-modules').textContent = status.modules;
        document.getElementById('bot-prefix').textContent = `Prefix: ${status.prefix}`;
    }
}

async function loadCommands() {
    const modules = await fetchData('commands');
    const container = document.getElementById('command-list');
    if (modules) {
        container.innerHTML = modules.map(mod => `
            <div class="cmd-card">
                <h4>${mod.name} <i class="fas fa-cube"></i></h4>
                <p>${mod.description}</p>
                <div class="cmd-tags">
                    ${mod.commands.map(cmd => `<span class="cmd-tag">!${cmd}</span>`).join('')}
                </div>
            </div>
        `).join('');
    }
}

async function loadGroups() {
    const groups = await fetchData('groups');
    const container = document.getElementById('group-list');
    if (groups) {
        container.innerHTML = groups.map(g => `
            <tr>
                <td><strong>${g.name}</strong></td>
                <td><code style="font-size:0.8rem; color:var(--text-secondary)">${g.id}</code></td>
                <td>${g.memberCount}</td>
                <td>
                    <span class="badge ${g.isRented ? 'success' : 'warning'}">
                        ${g.isRented ? 'Đã thuê' : 'Chưa thuê'}
                    </span>
                </td>
                <td>${g.expiry || 'N/A'}</td>
            </tr>
        `).join('');
    }
}

async function loadAdmins() {
    const admins = await fetchData('admins');
    const container = document.getElementById('admin-list');
    if (admins) {
        container.innerHTML = admins.map(admin => `
            <div class="admin-card">
                <img src="${admin.avatar || 'https://cdn-icons-png.flaticon.com/512/3135/3135715.png'}" alt="${admin.name}">
                <h4>${admin.name}</h4>
                <span>ID: ${admin.id}</span>
                <div style="margin-top:10px"><span class="badge success">Administrator</span></div>
            </div>
        `).join('');
    }
}

// Navigation
document.querySelectorAll('.sidebar nav a').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('href').substring(1);
        
        // Update active link
        document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.remove('active'));
        link.classList.add('active');
        
        // Show target page
        document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
        document.getElementById(targetId).classList.add('active');

        // Load data if needed
        if (targetId === 'commands') loadCommands();
        if (targetId === 'groups') loadGroups();
        if (targetId === 'admins') loadAdmins();
    });
});

// Controls
document.getElementById('btn-restart').addEventListener('click', async () => {
    if (confirm("Sếp chắc chắn muốn khởi động lại Bot không?")) {
        const res = await fetch('/api/restart', { method: 'POST' });
        const data = await res.json();
        alert(data.message);
        location.reload();
    }
});

document.getElementById('btn-shutdown').addEventListener('click', async () => {
    if (confirm("Sếp chắc chắn muốn TẮT Bot không? (Phải vào VPS bật lại thủ công đó ạ)")) {
        const res = await fetch('/api/shutdown', { method: 'POST' });
        const data = await res.json();
        alert(data.message);
    }
});

// Initial Load
updateStatus();
setInterval(updateStatus, 5000);

// Load logs (mockup for now)
function addLog(msg) {
    const container = document.getElementById('activity-log');
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    container.prepend(item);
    if (container.children.length > 10) container.lastElementChild.remove();
}

addLog("Hệ thống Dashboard đã kết nối.");
