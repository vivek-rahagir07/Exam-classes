/**
 * ExamSeat – College Exam Seating Plan Generator
 * Modern Vanilla JavaScript Frontend Engine
 * Storage: HTML5 localStorage
 */

(function () {
  'use strict';

  // =========================================================================
  // CONSTANTS & COLOR MAPPINGS
  // =========================================================================
  const STORAGE_KEYS = {
    STUDENTS: 'examseat_students_v2',
    ROOMS: 'examseat_rooms_v2',
    PLAN: 'examseat_active_plan_v2',
    CONFIG: 'examseat_generator_config_v2'
  };

  const BRANCH_COLORS = {
    'Computer Science (CSE)': '#2563eb',
    'Electronics (ECE)': '#059669',
    'Mechanical (ME)': '#d97706',
    'Information Tech (IT)': '#7c3aed',
    'Civil Engineering (CE)': '#0891b2',
    'Electrical (EE)': '#ea580c',
    'Other': '#475569'
  };

  function getBranchColor(branch) {
    if (!branch) return BRANCH_COLORS['Other'];
    for (const key in BRANCH_COLORS) {
      if (branch.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(branch.toLowerCase())) {
        return BRANCH_COLORS[key];
      }
    }
    // Deterministic fallback color
    let hash = 0;
    for (let i = 0; i < branch.length; i++) {
      hash = branch.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 70%, 45%)`;
  }



  // =========================================================================
  // STATE MANAGEMENT
  // =========================================================================
  const state = {
    students: [],
    rooms: [],
    plan: null,
    currentView: 'dashboard',
    selectedStudentIds: new Set(),
    activeRoomIdForPlan: null,
    activePlanSubTab: 'grid',
    activeReportType: 'door-notice',
    selectedLookupStudentId: null,

    // File Upload Temporary Cache
    uploadCache: {
      type: null, // 'students' or 'rooms'
      rawData: [],
      headers: [],
      mappedCols: {}
    }
  };

  function loadState() {
    try {
      const storedStudents = localStorage.getItem(STORAGE_KEYS.STUDENTS);
      const storedRooms = localStorage.getItem(STORAGE_KEYS.ROOMS);
      const storedPlan = localStorage.getItem(STORAGE_KEYS.PLAN);

      state.students = storedStudents ? JSON.parse(storedStudents) : [];
      state.rooms    = storedRooms    ? JSON.parse(storedRooms)    : [];
      state.plan     = storedPlan     ? JSON.parse(storedPlan)     : null;
    } catch (e) {
      console.error('Error loading localStorage state — starting fresh:', e);
      state.students = [];
      state.rooms    = [];
      state.plan     = null;
    }
  }

  function saveStudents() {
    localStorage.setItem(STORAGE_KEYS.STUDENTS, JSON.stringify(state.students));
  }

  function saveRooms() {
    localStorage.setItem(STORAGE_KEYS.ROOMS, JSON.stringify(state.rooms));
  }

  function savePlan() {
    if (state.plan) {
      localStorage.setItem(STORAGE_KEYS.PLAN, JSON.stringify(state.plan));
    } else {
      localStorage.removeItem(STORAGE_KEYS.PLAN);
    }
  }

  // =========================================================================
  // ALLOCATION ALGORITHMS & CORE ENGINE
  // =========================================================================
  function sortStudents(studentList, sortScheme) {
    const list = [...studentList];
    switch (sortScheme) {
      case 'ROLL_ASC':
        return list.sort((a, b) => (a.rollNumber || '').localeCompare(b.rollNumber || '', undefined, { numeric: true }));
      case 'ROLL_DESC':
        return list.sort((a, b) => (b.rollNumber || '').localeCompare(a.rollNumber || '', undefined, { numeric: true }));
      case 'NAME_ASC':
        return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      case 'NAME_DESC':
        return list.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
      case 'BRANCH_ROLL':
        return list.sort((a, b) => {
          const brComp = (a.branch || '').localeCompare(b.branch || '');
          if (brComp !== 0) return brComp;
          return (a.rollNumber || '').localeCompare(b.rollNumber || '', undefined, { numeric: true });
        });
      case 'SEM_BRANCH':
        return list.sort((a, b) => {
          const semComp = (a.semester || '').localeCompare(b.semester || '');
          if (semComp !== 0) return semComp;
          const brComp = (a.branch || '').localeCompare(b.branch || '');
          if (brComp !== 0) return brComp;
          return (a.rollNumber || '').localeCompare(b.rollNumber || '', undefined, { numeric: true });
        });
      case 'RANDOM':
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        return list;
      case 'UPLOAD_ORDER':
      default:
        return list;
    }
  }

  function formatSeatCode(room, rowIndex, colIndex, seqNum, prefixFormat) {
    const pad = (n) => String(n).padStart(2, '0');
    const cleanRoom = room.name.replace(/\s+/g, '');

    switch (prefixFormat) {
      case 'ROW_COL':
        return `R${rowIndex + 1}-C${colIndex + 1}`;
      case 'SEAT_ONLY':
        return `Seat-${pad(seqNum)}`;
      case 'BENCH_LR': {
        const benchNum = Math.floor(colIndex / 2) + 1;
        const side = colIndex % 2 === 0 ? 'L' : 'R';
        return `R${rowIndex + 1}-B${benchNum}-${side}`;
      }
      case 'ROOM_SEAT':
      default:
        return `${cleanRoom}-S${pad(seqNum)}`;
    }
  }

  /**
   * Main Seating Plan Generation Engine
   * Validates capacity constraints, allocates seats 1:1, guarantees 0 duplicates.
   */
  function executePlanGeneration({
    selectedBranches = null,
    selectedSemesters = null,
    selectedRoomIds = null,
    sortStrategy = 'ROLL_ASC',
    allocationStrategy = 'MIXED_BRANCHES',
    seatPrefixFormat = 'ROOM_SEAT'
  }) {
    // 1. Filter Candidate Students
    let candidates = state.students.filter(s => s.eligible);
    if (selectedBranches && selectedBranches.length > 0) {
      candidates = candidates.filter(s => selectedBranches.includes(s.branch));
    }
    if (selectedSemesters && selectedSemesters.length > 0) {
      candidates = candidates.filter(s => selectedSemesters.includes(s.semester));
    }

    if (candidates.length === 0) {
      return { success: false, error: 'No eligible students match your filter criteria.' };
    }

    // 2. Filter Candidate Rooms
    let activeRooms = state.rooms.filter(r => r.available);
    if (selectedRoomIds && selectedRoomIds.length > 0) {
      activeRooms = activeRooms.filter(r => selectedRoomIds.includes(r.id));
    }

    if (activeRooms.length === 0) {
      return { success: false, error: 'No available rooms selected for seating plan.' };
    }

    const totalCapacity = activeRooms.reduce((sum, r) => sum + Number(r.capacity), 0);
    if (candidates.length > totalCapacity) {
      return {
        success: false,
        error: `Insufficient Capacity! Required: ${candidates.length} seats, but selected rooms offer only ${totalCapacity} seats (Deficit: ${candidates.length - totalCapacity} seats). Please enable more rooms.`
      };
    }

    // 3. Sort Candidates
    let sortedCandidates = sortStudents(candidates, sortStrategy);

    // 4. If Strategy is MIXED_BRANCHES: Interleave students from different branches
    if (allocationStrategy === 'MIXED_BRANCHES') {
      const branchBuckets = {};
      sortedCandidates.forEach(s => {
        if (!branchBuckets[s.branch]) branchBuckets[s.branch] = [];
        branchBuckets[s.branch].push(s);
      });

      const branchKeys = Object.keys(branchBuckets);
      const interleaved = [];
      let added = true;
      let round = 0;

      while (added) {
        added = false;
        for (const bKey of branchKeys) {
          if (branchBuckets[bKey].length > 0) {
            interleaved.push(branchBuckets[bKey].shift());
            added = true;
          }
        }
        round++;
      }
      sortedCandidates = interleaved;
    }

    // 5. Initialize Room Allotment Structures
    const roomPlans = {};
    activeRooms.forEach(room => {
      roomPlans[room.id] = {
        room: { ...room },
        seats: [],
        allocatedCount: 0,
        branchCounts: {}
      };
    });

    // 6. Seat Allocation by Strategy
    if (allocationStrategy === 'ROUND_ROBIN') {
      // Round Robin distribution across rooms
      let studentIdx = 0;
      let roomIndex = 0;
      const roomSeqCounters = {};
      activeRooms.forEach(r => roomSeqCounters[r.id] = 0);

      while (studentIdx < sortedCandidates.length) {
        const room = activeRooms[roomIndex % activeRooms.length];
        const rPlan = roomPlans[room.id];

        if (rPlan.allocatedCount < room.capacity) {
          const student = sortedCandidates[studentIdx];
          const seqNum = ++roomSeqCounters[room.id];
          const seatIndex = seqNum - 1;
          const rows = Number(room.rows) || 1;
          const cols = Number(room.cols) || Math.ceil(room.capacity / rows);
          const rIdx = Math.floor(seatIndex / cols);
          const cIdx = seatIndex % cols;

          const seatCode = formatSeatCode(room, rIdx, cIdx, seqNum, seatPrefixFormat);

          rPlan.seats.push({
            seatNumber: seatCode,
            seatSeq: seqNum,
            rowIndex: rIdx,
            colIndex: cIdx,
            student: student
          });

          rPlan.allocatedCount++;
          rPlan.branchCounts[student.branch] = (rPlan.branchCounts[student.branch] || 0) + 1;
          studentIdx++;
        }

        roomIndex++;
      }
    } else {
      // Sequential, Mixed Branches, or Spaced Filling room-by-room
      let candidatePtr = 0;

      for (const room of activeRooms) {
        const rPlan = roomPlans[room.id];
        const rows = Number(room.rows) || 1;
        const cols = Number(room.cols) || Math.ceil(room.capacity / rows);
        let seq = 0;

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (seq >= room.capacity || candidatePtr >= sortedCandidates.length) {
              break;
            }

            // Check if checkerboard spacing is requested
            const isSpaced = allocationStrategy === 'SPACED_CHECKERBOARD';
            if (isSpaced && (r + c) % 2 !== 0 && (sortedCandidates.length <= totalCapacity / 2)) {
              // Leave empty seat buffer
              seq++;
              continue;
            }

            seq++;
            const student = sortedCandidates[candidatePtr++];
            const seatCode = formatSeatCode(room, r, c, seq, seatPrefixFormat);

            rPlan.seats.push({
              seatNumber: seatCode,
              seatSeq: seq,
              rowIndex: r,
              colIndex: c,
              student: student
            });

            rPlan.allocatedCount++;
            rPlan.branchCounts[student.branch] = (rPlan.branchCounts[student.branch] || 0) + 1;
          }
          if (candidatePtr >= sortedCandidates.length) break;
        }

        if (candidatePtr >= sortedCandidates.length) break;
      }
    }

    // Build Master Record Map for quick lookup
    const studentLookup = {};
    Object.values(roomPlans).forEach(rp => {
      rp.seats.forEach(seat => {
        studentLookup[seat.student.id] = {
          student: seat.student,
          room: rp.room,
          seatNumber: seat.seatNumber,
          seatSeq: seat.seatSeq,
          rowIndex: seat.rowIndex,
          colIndex: seat.colIndex
        };
      });
    });

    const generatedPlan = {
      id: `plan_${Date.now()}`,
      timestamp: new Date().toISOString(),
      formattedDate: new Date().toLocaleDateString('en-US', {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      }),
      config: {
        sortStrategy,
        allocationStrategy,
        seatPrefixFormat,
        selectedBranches: selectedBranches || 'ALL',
        selectedSemesters: selectedSemesters || 'ALL'
      },
      stats: {
        totalAllocated: sortedCandidates.length,
        totalCapacity,
        roomCount: activeRooms.length,
        utilizationPct: Math.round((sortedCandidates.length / totalCapacity) * 100)
      },
      roomPlans,
      studentLookup
    };

    state.plan = generatedPlan;
    savePlan();
    return { success: true, plan: generatedPlan };
  }

  function generateDefaultPlan() {
    executePlanGeneration({
      sortStrategy: 'ROLL_ASC',
      allocationStrategy: 'MIXED_BRANCHES',
      seatPrefixFormat: 'ROOM_SEAT'
    });
  }

  // =========================================================================
  // TOAST & CONFIRM DIALOG HELPERS
  // =========================================================================
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '⚠️';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  function openConfirmDialog({ title = 'Please Confirm', message, onConfirm }) {
    const dialog = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmModalTitle');
    const msgEl = document.getElementById('confirmModalMessage');
    const btnOk = document.getElementById('btnConfirmOk');
    const btnCancel = document.getElementById('btnConfirmCancel');

    titleEl.textContent = title;
    msgEl.textContent = message;

    const handleOk = () => {
      dialog.close();
      cleanup();
      if (typeof onConfirm === 'function') onConfirm();
    };

    const handleCancel = () => {
      dialog.close();
      cleanup();
    };

    function cleanup() {
      btnOk.removeEventListener('click', handleOk);
      btnCancel.removeEventListener('click', handleCancel);
    }

    btnOk.addEventListener('click', handleOk);
    btnCancel.addEventListener('click', handleCancel);

    dialog.showModal();
  }

  // =========================================================================
  // UI RENDERERS
  // =========================================================================

  // --- View Switching ---
  function switchView(viewName) {
    state.currentView = viewName;

    // Update active nav item
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      if (btn.dataset.view === viewName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Update view sections
    document.querySelectorAll('.view-panel').forEach(panel => {
      if (panel.id === `view-${viewName}`) {
        panel.classList.add('active');
      } else {
        panel.classList.remove('active');
      }
    });

    // Header title update
    const titleEl = document.getElementById('pageTitle');
    const subEl = document.getElementById('pageSubtitle');
    const titles = {
      dashboard: { title: 'Dashboard Overview', sub: 'Semester Examination Seating Plan Management' },
      students: { title: 'Students Directory & Upload', sub: 'Manage enrolled candidates, CSV/Excel imports & eligibility' },
      rooms: { title: 'Exam Rooms & Capacity', sub: 'Configure exam halls, grid dimensions, and venues' },
      generator: { title: 'Plan Generator & Strategy', sub: 'Configure anti-cheating distribution and generate plans' },
      plans: { title: 'Active Seating Plans', sub: 'Interactive classroom visualizer, attendance roster & lookup' },
      reports: { title: 'Export & Printable Reports', sub: 'Official door notices, invigilator sheets and master CSVs' }
    };

    if (titles[viewName]) {
      titleEl.textContent = titles[viewName].title;
      subEl.textContent = titles[viewName].sub;
    }

    // Trigger View-specific Render
    if (viewName === 'dashboard') renderDashboard();
    if (viewName === 'students') renderStudents();
    if (viewName === 'rooms') renderRooms();
    if (viewName === 'generator') renderGeneratorView();
    if (viewName === 'plans') renderPlansView();
    if (viewName === 'reports') renderReportsView();

    // Close mobile sidebar if open
    closeMobileSidebar();
  }

  // --- Render Dashboard ---
  function renderDashboard() {
    const totalStudents = state.students.length;
    const eligibleStudents = state.students.filter(s => s.eligible).length;
    const totalRooms = state.rooms.length;
    const availableRooms = state.rooms.filter(r => r.available).length;
    const totalCapacity = state.rooms.filter(r => r.available).reduce((acc, r) => acc + Number(r.capacity), 0);

    const allocatedCount = state.plan ? state.plan.stats.totalAllocated : 0;
    const utilizationPct = totalCapacity > 0 ? Math.round((allocatedCount / totalCapacity) * 100) : 0;
    const surplus = totalCapacity - eligibleStudents;

    // Badges & Metrics
    document.getElementById('badgeStudentCount').textContent = totalStudents;
    document.getElementById('badgeRoomCount').textContent = totalRooms;

    document.getElementById('dashTotalStudents').textContent = totalStudents;
    document.getElementById('dashEligibleSub').textContent = `${eligibleStudents} eligible for exam`;

    document.getElementById('dashTotalRooms').textContent = totalRooms;
    document.getElementById('dashAvailableRoomsSub').textContent = `${availableRooms} active halls`;

    document.getElementById('dashTotalCapacity').textContent = totalCapacity;
    const surplusEl = document.getElementById('dashCapacitySurplus');
    if (surplus >= 0) {
      surplusEl.textContent = `Surplus: +${surplus} seats`;
      surplusEl.className = 'metric-sub text-success';
    } else {
      surplusEl.textContent = `Deficit: ${surplus} seats`;
      surplusEl.className = 'metric-sub text-danger';
    }

    document.getElementById('dashAllocationRatio').textContent = `${allocatedCount} / ${eligibleStudents}`;
    document.getElementById('dashProgressBar').style.width = `${Math.min(utilizationPct, 100)}%`;
    document.getElementById('dashAllocationPct').textContent = `${utilizationPct}% exam hall occupancy`;

    // Workflow Stepper text
    document.getElementById('stepStudentStatus').textContent = totalStudents === 0
      ? 'No students added yet'
      : `${totalStudents} students (${eligibleStudents} eligible)`;
    document.getElementById('stepRoomStatus').textContent = availableRooms === 0
      ? 'No rooms configured yet'
      : `${availableRooms} rooms (${totalCapacity} seats)`;

    // Active Plan Summary Card
    const summaryBox = document.getElementById('dashActivePlanSummary');
    if (state.plan && state.plan.stats.totalAllocated > 0) {
      document.getElementById('badgePlanStatus').textContent = 'Ready';
      document.getElementById('badgePlanStatus').className = 'badge badge-success';

      const stratNames = {
        'MIXED_BRANCHES': 'Mixed Branches (Anti-Cheating)',
        'SEQUENTIAL': 'Sequential Room Filling',
        'ROUND_ROBIN': 'Round-Robin / Balanced',
        'SPACED_CHECKERBOARD': 'Checkerboard Spaced'
      };

      summaryBox.innerHTML = `
        <div class="active-plan-info">
          <div class="d-flex justify-between align-center mb-2">
            <div>
              <strong style="font-size: 1.05rem; color: var(--primary-900);">Active Plan #${state.plan.id.slice(-6)}</strong>
              <div class="text-xs text-muted">Generated: ${state.plan.formattedDate}</div>
            </div>
            <span class="badge badge-primary">${stratNames[state.plan.config.allocationStrategy] || 'Standard'}</span>
          </div>

          <div style="background: #f8fafc; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.85rem; margin-bottom: 1rem;">
            <div class="d-flex justify-between text-sm mb-1">
              <span>Candidate Seats Filled:</span>
              <strong>${state.plan.stats.totalAllocated} of ${state.plan.stats.totalCapacity} (${state.plan.stats.utilizationPct}%)</strong>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" style="width: ${state.plan.stats.utilizationPct}%"></div>
            </div>
          </div>

          <div class="table-responsive">
            <table class="data-table data-table-sm">
              <thead>
                <tr>
                  <th>Venue Room</th>
                  <th>Capacity</th>
                  <th>Assigned</th>
                  <th>Occupancy</th>
                </tr>
              </thead>
              <tbody>
                ${Object.values(state.plan.roomPlans).map(rp => {
                  const pct = Math.round((rp.allocatedCount / rp.room.capacity) * 100);
                  return `
                    <tr>
                      <td><strong>${rp.room.name}</strong> <span class="text-xs text-muted">(${rp.room.building})</span></td>
                      <td>${rp.room.capacity}</td>
                      <td><strong>${rp.allocatedCount}</strong></td>
                      <td>
                        <span class="badge ${pct === 100 ? 'badge-primary' : 'badge-neutral'}">${pct}%</span>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      document.getElementById('badgePlanStatus').textContent = 'Pending';
      document.getElementById('badgePlanStatus').className = 'badge badge-accent';
      summaryBox.innerHTML = `
        <div class="empty-state p-3">
          <p class="text-muted">No active seating plan generated yet.</p>
          <button class="btn btn-primary btn-sm mt-2" onclick="app.switchView('generator')">
            Configure & Generate Now
          </button>
        </div>
      `;
    }

    // Branch Breakdown List
    const branchCounts = {};
    state.students.forEach(s => {
      branchCounts[s.branch] = (branchCounts[s.branch] || 0) + 1;
    });

    const branchListEl = document.getElementById('dashBranchList');
    const branchKeys = Object.keys(branchCounts);
    document.getElementById('dashTotalBranchesBadge').textContent = `${branchKeys.length} Departments`;

    branchListEl.innerHTML = branchKeys.map(bName => {
      const bCount = branchCounts[bName];
      const pct = totalStudents > 0 ? Math.round((bCount / totalStudents) * 100) : 0;
      const color = getBranchColor(bName);
      return `
        <div class="branch-stat-item">
          <div class="branch-info">
            <span class="branch-tag-pill" style="background: ${color};">${bName.split('(')[1]?.replace(')', '') || bName.slice(0, 4)}</span>
            <span style="font-size: 0.85rem; font-weight: 600;">${bName}</span>
          </div>
          <div class="d-flex align-center gap-2">
            <div class="branch-bar-wrap">
              <div class="branch-bar-fill" style="width: ${pct}%; background: ${color};"></div>
            </div>
            <strong style="font-size: 0.82rem; min-width: 45px; text-align: right;">${bCount} (${pct}%)</strong>
          </div>
        </div>
      `;
    }).join('');

    // Room Capacity Meters on Dashboard
    const roomMetersEl = document.getElementById('dashRoomCapacityCards');
    roomMetersEl.innerHTML = state.rooms.map(room => {
      const rPlan = state.plan?.roomPlans?.[room.id];
      const assigned = rPlan ? rPlan.allocatedCount : 0;
      const pct = Math.round((assigned / room.capacity) * 100);

      return `
        <div class="room-meter-card">
          <div class="room-meter-header">
            <div>
              <div class="room-meter-title">${room.name}</div>
              <div class="room-meter-building">${room.building}</div>
            </div>
            <span class="badge ${room.available ? 'badge-success' : 'badge-danger'}">
              ${room.available ? 'Active' : 'Disabled'}
            </span>
          </div>
          <div class="d-flex justify-between text-xs mb-1">
            <span class="text-muted">Seating:</span>
            <strong>${assigned} / ${room.capacity} seats</strong>
          </div>
          <div class="progress-bar-wrap">
            <div class="progress-bar" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Render Students View ---
  function renderStudents() {
    populateStudentFilters();

    const searchTerm = (document.getElementById('studentSearchInput').value || '').toLowerCase().trim();
    const branchFilter = document.getElementById('filterStudentBranch').value;
    const semFilter = document.getElementById('filterStudentSemester').value;
    const statusFilter = document.getElementById('filterStudentStatus').value;

    let filtered = state.students.filter(student => {
      // Search query
      if (searchTerm) {
        const matchesRoll = (student.rollNumber || '').toLowerCase().includes(searchTerm);
        const matchesName = (student.name || '').toLowerCase().includes(searchTerm);
        const matchesBranch = (student.branch || '').toLowerCase().includes(searchTerm);
        const matchesSub = (student.subject || '').toLowerCase().includes(searchTerm);
        if (!matchesRoll && !matchesName && !matchesBranch && !matchesSub) return false;
      }
      // Branch filter
      if (branchFilter !== 'ALL' && student.branch !== branchFilter) return false;
      // Semester filter
      if (semFilter !== 'ALL' && student.semester !== semFilter) return false;
      // Status filter
      if (statusFilter === 'ELIGIBLE' && !student.eligible) return false;
      if (statusFilter === 'EXCLUDED' && student.eligible) return false;

      return true;
    });

    const tbody = document.getElementById('studentsTableBody');
    const emptyState = document.getElementById('studentsEmptyState');
    const badgeCount = document.getElementById('studentFilteredCountBadge');
    badgeCount.textContent = `Showing ${filtered.length} of ${state.students.length}`;

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    tbody.innerHTML = filtered.map(student => {
      const isSelected = state.selectedStudentIds.has(student.id);
      const color = getBranchColor(student.branch);

      return `
        <tr class="${isSelected ? 'row-selected' : ''}">
          <td>
            <input type="checkbox" class="student-select-cb" data-id="${student.id}" ${isSelected ? 'checked' : ''}>
          </td>
          <td>
            <span class="roll-code">${student.rollNumber}</span>
          </td>
          <td>
            <strong>${student.name}</strong>
          </td>
          <td>
            <span class="badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44;">
              ${student.branch}
            </span>
          </td>
          <td>${student.semester || 'Sem 4'}</td>
          <td class="text-muted text-xs">${student.subject || '—'}</td>
          <td>
            <button class="btn btn-xs ${student.eligible ? 'btn-ghost text-success' : 'btn-ghost text-danger'}"
              onclick="app.toggleStudentEligibility('${student.id}')" title="Click to toggle eligibility">
              ${student.eligible ? '● Eligible' : '○ Excluded'}
            </button>
          </td>
          <td class="text-right">
            <button class="btn-icon btn-sm" onclick="app.openEditStudentModal('${student.id}')" title="Edit Student">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="btn-icon btn-sm text-danger" onclick="app.deleteStudent('${student.id}')" title="Delete Student">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </td>
        </tr>
      `;
    }).join('');

    updateBulkStudentRibbon();
  }

  function populateStudentFilters() {
    const branchSelect = document.getElementById('filterStudentBranch');
    const semSelect = document.getElementById('filterStudentSemester');

    const currentBranch = branchSelect.value;
    const currentSem = semSelect.value;

    const branches = Array.from(new Set(state.students.map(s => s.branch))).filter(Boolean);
    const semesters = Array.from(new Set(state.students.map(s => s.semester))).filter(Boolean);

    branchSelect.innerHTML = `<option value="ALL">All Branches</option>` +
      branches.map(b => `<option value="${b}" ${b === currentBranch ? 'selected' : ''}>${b}</option>`).join('');

    semSelect.innerHTML = `<option value="ALL">All Semesters</option>` +
      semesters.map(s => `<option value="${s}" ${s === currentSem ? 'selected' : ''}>${s}</option>`).join('');
  }

  function updateBulkStudentRibbon() {
    const ribbon = document.getElementById('studentBulkRibbon');
    const countEl = document.getElementById('studentSelectedCount');
    const count = state.selectedStudentIds.size;

    if (count > 0) {
      ribbon.style.display = 'flex';
      countEl.textContent = count;
    } else {
      ribbon.style.display = 'none';
    }
  }

  // --- Render Rooms View ---
  function renderRooms() {
    populateRoomFilters();

    const searchTerm = (document.getElementById('roomSearchInput').value || '').toLowerCase().trim();
    const bldgFilter = document.getElementById('filterRoomBuilding').value;
    const statusFilter = document.getElementById('filterRoomStatus').value;

    let filtered = state.rooms.filter(room => {
      if (searchTerm) {
        const matchesName = (room.name || '').toLowerCase().includes(searchTerm);
        const matchesBldg = (room.building || '').toLowerCase().includes(searchTerm);
        if (!matchesName && !matchesBldg) return false;
      }
      if (bldgFilter !== 'ALL' && room.building !== bldgFilter) return false;
      if (statusFilter === 'AVAILABLE' && !room.available) return false;
      if (statusFilter === 'DISABLED' && room.available) return false;
      return true;
    });

    // Demand vs Capacity Banner
    const totalAvailCap = state.rooms.filter(r => r.available).reduce((acc, r) => acc + Number(r.capacity), 0);
    const eligibleStudents = state.students.filter(s => s.eligible).length;
    const margin = totalAvailCap - eligibleStudents;

    const demandBanner = document.getElementById('roomDemandBanner');
    if (margin < 0) {
      demandBanner.innerHTML = `
        <div class="alert alert-danger">
          <div>
            <strong>Capacity Shortage Warning:</strong>
            ${eligibleStudents} eligible students require seats, but total active room capacity is only ${totalAvailCap} seats (Deficit of ${Math.abs(margin)} seats).
          </div>
          <button class="btn btn-sm btn-primary" onclick="app.openAddRoomModal()">Add Room</button>
        </div>
      `;
    } else {
      demandBanner.innerHTML = `
        <div class="alert alert-success">
          <div>
            <strong>Sufficient Seating Available:</strong>
            Total active capacity (${totalAvailCap} seats) satisfies candidate requirement of ${eligibleStudents} students (Surplus margin: +${margin} seats).
          </div>
          <span class="badge badge-success">Feasible</span>
        </div>
      `;
    }

    const container = document.getElementById('roomsContainer');
    const emptyState = document.getElementById('roomsEmptyState');

    if (filtered.length === 0) {
      container.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    container.innerHTML = filtered.map(room => {
      const rPlan = state.plan?.roomPlans?.[room.id];
      const assigned = rPlan ? rPlan.allocatedCount : 0;
      const pct = Math.round((assigned / room.capacity) * 100);

      return `
        <div class="room-card">
          <div class="room-card-head">
            <div>
              <div class="room-card-title">${room.name}</div>
              <div class="room-card-building">${room.building}</div>
            </div>
            <button class="btn btn-xs ${room.available ? 'badge-success' : 'badge-danger'}"
              onclick="app.toggleRoomAvailability('${room.id}')" title="Click to toggle availability">
              ${room.available ? 'Available' : 'Disabled'}
            </button>
          </div>

          <div class="room-specs-grid">
            <div>
              <div class="room-spec-val">${room.capacity}</div>
              <div class="room-spec-lbl">Capacity</div>
            </div>
            <div>
              <div class="room-spec-val">${room.rows || '—'} &times; ${room.cols || '—'}</div>
              <div class="room-spec-lbl">Grid (R&times;C)</div>
            </div>
            <div>
              <div class="room-spec-val">${assigned}</div>
              <div class="room-spec-lbl">Allocated</div>
            </div>
          </div>

          ${room.notes ? `<p class="text-xs text-muted mb-2">💡 ${room.notes}</p>` : ''}

          <div class="mt-2">
            <div class="d-flex justify-between text-xs mb-1">
              <span class="text-muted">Utilization:</span>
              <strong>${pct}% filled</strong>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" style="width: ${pct}%"></div>
            </div>
          </div>

          <div class="room-card-footer">
            <button class="btn btn-sm btn-outline" onclick="app.openEditRoomModal('${room.id}')">
              Edit Room
            </button>
            <button class="btn btn-sm btn-ghost text-danger" onclick="app.deleteRoom('${room.id}')">
              Delete
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function populateRoomFilters() {
    const bldgSelect = document.getElementById('filterRoomBuilding');
    const currentVal = bldgSelect.value;
    const bldgs = Array.from(new Set(state.rooms.map(r => r.building))).filter(Boolean);

    bldgSelect.innerHTML = `<option value="ALL">All Buildings / Blocks</option>` +
      bldgs.map(b => `<option value="${b}" ${b === currentVal ? 'selected' : ''}>${b}</option>`).join('');
  }

  // --- Render Generator View ---
  function renderGeneratorView() {
    // 1. Populate Branch Checkboxes
    const branches = Array.from(new Set(state.students.map(s => s.branch))).filter(Boolean);
    const branchContainer = document.getElementById('genBranchCheckboxes');
    branchContainer.innerHTML = branches.map(b => {
      const count = state.students.filter(s => s.branch === b && s.eligible).length;
      return `
        <label class="cohort-pill-checkbox">
          <input type="checkbox" class="gen-branch-cb" value="${b}" checked onchange="app.updateGeneratorFeasibility()">
          <span>${b}</span>
          <span class="badge badge-neutral" style="margin-left: auto;">${count}</span>
        </label>
      `;
    }).join('');

    // 2. Populate Semester Checkboxes
    const semesters = Array.from(new Set(state.students.map(s => s.semester))).filter(Boolean);
    const semContainer = document.getElementById('genSemesterCheckboxes');
    semContainer.innerHTML = semesters.map(sem => {
      const count = state.students.filter(s => s.semester === sem && s.eligible).length;
      return `
        <label class="cohort-pill-checkbox">
          <input type="checkbox" class="gen-sem-cb" value="${sem}" checked onchange="app.updateGeneratorFeasibility()">
          <span>${sem}</span>
          <span class="badge badge-neutral" style="margin-left: auto;">${count}</span>
        </label>
      `;
    }).join('');

    // 3. Populate Room Checkboxes
    const roomContainer = document.getElementById('genRoomsCheckboxes');
    roomContainer.innerHTML = state.rooms.map(room => {
      return `
        <div class="gen-room-item">
          <label class="checkbox-label">
            <input type="checkbox" class="gen-room-cb" value="${room.id}" ${room.available ? 'checked' : ''} onchange="app.updateGeneratorFeasibility()">
            <strong>${room.name}</strong>
            <span class="text-xs text-muted">(${room.building})</span>
          </label>
          <span class="badge badge-primary">${room.capacity} seats</span>
        </div>
      `;
    }).join('');

    updateGeneratorFeasibility();
  }

  function updateGeneratorFeasibility() {
    // Calculate selected students
    const selectedBranches = Array.from(document.querySelectorAll('.gen-branch-cb:checked')).map(cb => cb.value);
    const selectedSemesters = Array.from(document.querySelectorAll('.gen-sem-cb:checked')).map(cb => cb.value);
    const selectedRooms = Array.from(document.querySelectorAll('.gen-room-cb:checked')).map(cb => cb.value);

    let eligibleCandidates = state.students.filter(s => s.eligible);
    if (selectedBranches.length > 0) {
      eligibleCandidates = eligibleCandidates.filter(s => selectedBranches.includes(s.branch));
    } else {
      eligibleCandidates = [];
    }
    if (selectedSemesters.length > 0) {
      eligibleCandidates = eligibleCandidates.filter(s => selectedSemesters.includes(s.semester));
    } else {
      eligibleCandidates = [];
    }

    const totalStudentsCount = eligibleCandidates.length;
    document.getElementById('genSelectedStudentsCountBadge').innerHTML =
      `Selected Students: <strong>${totalStudentsCount}</strong> candidates`;

    // Calculate selected capacity
    const activeRooms = state.rooms.filter(r => selectedRooms.includes(r.id));
    const totalCapacity = activeRooms.reduce((sum, r) => sum + Number(r.capacity), 0);
    document.getElementById('genSelectedRoomsCapacityBadge').innerHTML =
      `Total Selected Capacity: <strong>${totalCapacity}</strong> seats`;

    // Summary Card
    document.getElementById('genSummaryStudentCount').textContent = totalStudentsCount;
    document.getElementById('genSummaryCapacityCount').textContent = totalCapacity;
    document.getElementById('genSummaryRoomCount').textContent = activeRooms.length;

    const surplus = totalCapacity - totalStudentsCount;
    const surplusEl = document.getElementById('genSummarySurplus');
    const badgeEl = document.getElementById('genFeasibilityBadge');
    const msgBox = document.getElementById('genValidationMsgBox');
    const btnExecute = document.getElementById('btnExecuteGenerate');

    const utilPct = totalCapacity > 0 ? Math.round((totalStudentsCount / totalCapacity) * 100) : 0;
    document.getElementById('genSummaryUtilizationPct').textContent = `${utilPct}%`;
    document.getElementById('genSummaryProgressBar').style.width = `${Math.min(utilPct, 100)}%`;

    if (totalStudentsCount === 0) {
      surplusEl.textContent = '0 seats';
      badgeEl.textContent = 'No Students';
      badgeEl.className = 'badge badge-danger';
      msgBox.className = 'validation-message-box alert alert-warning';
      msgBox.innerHTML = '⚠️ Please select at least one branch and semester with enrolled candidates.';
      btnExecute.disabled = true;
    } else if (activeRooms.length === 0) {
      surplusEl.textContent = '0 seats';
      badgeEl.textContent = 'No Rooms';
      badgeEl.className = 'badge badge-danger';
      msgBox.className = 'validation-message-box alert alert-danger';
      msgBox.innerHTML = '⚠️ Please select at least one examination room.';
      btnExecute.disabled = true;
    } else if (surplus < 0) {
      surplusEl.textContent = `${surplus} seats (Deficit)`;
      surplusEl.style.color = '#ef4444';
      badgeEl.textContent = 'Over Capacity';
      badgeEl.className = 'badge badge-danger';
      msgBox.className = 'validation-message-box alert alert-danger';
      msgBox.innerHTML = `⚠️ Deficit of ${Math.abs(surplus)} seats! ${totalStudentsCount} students require seats, but selected rooms only fit ${totalCapacity}. Select more halls to proceed.`;
      btnExecute.disabled = true;
    } else {
      surplusEl.textContent = `+${surplus} seats`;
      surplusEl.style.color = '#059669';
      badgeEl.textContent = 'Feasible';
      badgeEl.className = 'badge badge-success';
      msgBox.className = 'validation-message-box alert alert-success';
      msgBox.innerHTML = `✅ Ready to generate! Every candidate will receive a unique seat without exceeding hall capacities.`;
      btnExecute.disabled = false;
    }
  }

  // --- Render Plans View ---
  function renderPlansView() {
    if (!state.plan || !state.plan.roomPlans) {
      document.getElementById('planRoomPills').innerHTML = '';
      document.getElementById('activeRoomTitle').textContent = 'No Seating Plan Generated';
      document.getElementById('activeRoomMeta').textContent = 'Add students & rooms, then run the Plan Generator.';
      document.getElementById('activeRoomBranchPills').innerHTML = '';
      document.getElementById('classroomDesksGrid').innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;padding:3rem;">
          <div class="empty-icon">📋</div>
          <h3>No Seating Plan Yet</h3>
          <p>Configure students &amp; rooms, then generate a plan to see classroom layouts here.</p>
          <button class="btn btn-primary mt-2" onclick="app.switchView('generator')">Go to Plan Generator</button>
        </div>`;
      document.getElementById('rosterTableBody').innerHTML =
        `<tr><td colspan="8" class="text-center text-muted" style="padding:2.5rem;">No plan generated yet. Use the <strong>Plan Generator</strong> to create one.</td></tr>`;
      document.getElementById('lookupResultsList').innerHTML =
        `<div class="text-muted" style="padding:1rem;">No plan generated yet.</div>`;
      document.getElementById('planStatsCards').innerHTML = '';
      document.getElementById('branchMatrixTable').innerHTML = '';
      return;
    }


    // Ensure valid active room
    const roomKeys = Object.keys(state.plan.roomPlans);
    if (!state.activeRoomIdForPlan || !state.plan.roomPlans[state.activeRoomIdForPlan]) {
      state.activeRoomIdForPlan = roomKeys[0];
    }

    // Render Room Navigation Pills
    const pillsContainer = document.getElementById('planRoomPills');
    pillsContainer.innerHTML = roomKeys.map(rId => {
      const rp = state.plan.roomPlans[rId];
      const isActive = rId === state.activeRoomIdForPlan;
      return `
        <button class="room-pill-btn ${isActive ? 'active' : ''}" onclick="app.setActivePlanRoom('${rId}')">
          ${rp.room.name} (${rp.allocatedCount}/${rp.room.capacity})
        </button>
      `;
    }).join('');

    // Active Room Banner
    const activeRP = state.plan.roomPlans[state.activeRoomIdForPlan];
    if (activeRP) {
      document.getElementById('activeRoomTitle').textContent = `Examination Venue: ${activeRP.room.name}`;
      document.getElementById('activeRoomMeta').textContent =
        `Building: ${activeRP.room.building} • Dimensions: ${activeRP.room.rows || '—'} Rows × ${activeRP.room.cols || '—'} Columns • Seated: ${activeRP.allocatedCount} / ${activeRP.room.capacity} Candidates`;

      const branchPillsEl = document.getElementById('activeRoomBranchPills');
      branchPillsEl.innerHTML = Object.entries(activeRP.branchCounts).map(([branch, count]) => {
        const color = getBranchColor(branch);
        return `
          <span class="badge" style="background: rgba(255,255,255,0.2); color: #fff; border: 1px solid rgba(255,255,255,0.4);">
            ${branch.split('(')[1]?.replace(')', '') || branch}: ${count}
          </span>
        `;
      }).join('');
    }

    // Sub-tab toggling
    document.querySelectorAll('.subnav-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.plantab === state.activePlanSubTab);
    });
    document.querySelectorAll('.plan-tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `planContent-${state.activePlanSubTab}`);
    });

    if (state.activePlanSubTab === 'grid') renderClassroomGrid(activeRP);
    if (state.activePlanSubTab === 'roster') renderAttendanceRoster(activeRP);
    if (state.activePlanSubTab === 'lookup') renderStudentLookup();
    if (state.activePlanSubTab === 'stats') renderOccupancyStats();
  }

  function renderClassroomGrid(roomPlan) {
    if (!roomPlan) return;
    const gridEl = document.getElementById('classroomDesksGrid');
    const rows = Number(roomPlan.room.rows) || 4;
    const cols = Number(roomPlan.room.cols) || 6;

    gridEl.style.gridTemplateColumns = `repeat(${cols}, 130px)`;
    gridEl.innerHTML = '';

    // Create a 2D map of allocated seats
    const seatMatrix = {};
    roomPlan.seats.forEach(seat => {
      const key = `${seat.rowIndex}_${seat.colIndex}`;
      seatMatrix[key] = seat;
    });

    let totalDesks = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        totalDesks++;
        const seat = seatMatrix[`${r}_${c}`];

        const deskEl = document.createElement('div');
        if (seat) {
          const color = getBranchColor(seat.student.branch);
          const shortBranch = seat.student.branch.split('(')[1]?.replace(')', '') || seat.student.branch.slice(0, 4);

          deskEl.className = 'desk-item';
          deskEl.style.borderTop = `4px solid ${color}`;
          deskEl.innerHTML = `
            <div class="desk-header">
              <span class="desk-num">${seat.seatNumber}</span>
              <span class="desk-branch-tag" style="background: ${color};">${shortBranch}</span>
            </div>
            <div class="desk-body">
              <div class="desk-roll">${seat.student.rollNumber}</div>
              <div class="desk-name" title="${seat.student.name}">${seat.student.name}</div>
            </div>
          `;
          deskEl.addEventListener('click', () => openSeatDetailModal(seat, roomPlan.room));
        } else {
          deskEl.className = 'desk-item vacant';
          deskEl.innerHTML = `
            <div class="desk-header">
              <span class="desk-num" style="background: #94a3b8;">R${r + 1}-C${c + 1}</span>
            </div>
            <div class="desk-body text-muted text-xs">
              Vacant
            </div>
          `;
        }

        gridEl.appendChild(deskEl);
      }
    }

    // Legend
    const legendEl = document.getElementById('classroomLegend');
    const branchesInRoom = Object.keys(roomPlan.branchCounts);
    legendEl.innerHTML = `<span class="legend-title">Branch Color Key:</span>` +
      branchesInRoom.map(b => {
        const color = getBranchColor(b);
        return `
          <span class="legend-item">
            <span class="desk-dot" style="background: ${color};"></span>
            ${b} (${roomPlan.branchCounts[b]})
          </span>
        `;
      }).join('') +
      `<span class="legend-item"><span class="desk-dot vacant"></span> Vacant / Buffer Seat</span>`;
  }

  function renderAttendanceRoster(roomPlan) {
    if (!roomPlan) return;
    const tbody = document.getElementById('rosterTableBody');

    if (roomPlan.seats.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted p-4">No candidates allocated to this hall.</td></tr>`;
      return;
    }

    tbody.innerHTML = roomPlan.seats.map(seat => {
      const color = getBranchColor(seat.student.branch);
      return `
        <tr>
          <td><strong class="roll-code">${seat.seatNumber}</strong></td>
          <td><span class="roll-code">${seat.student.rollNumber}</span></td>
          <td><strong>${seat.student.name}</strong></td>
          <td>
            <span class="badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44;">
              ${seat.student.branch}
            </span>
          </td>
          <td>${seat.student.semester || 'Sem 4'}</td>
          <td class="text-xs text-muted">${seat.student.subject || '—'}</td>
          <td style="border-bottom: 1px dashed #cbd5e1; height: 35px;"></td>
          <td><span class="badge badge-success">Present</span></td>
        </tr>
      `;
    }).join('');
  }

  function renderStudentLookup() {
    const searchInput = document.getElementById('lookupSearchInput');
    const query = (searchInput.value || '').toLowerCase().trim();
    const resultsContainer = document.getElementById('lookupResultsList');

    if (!state.plan || !state.plan.studentLookup) {
      resultsContainer.innerHTML = '<div class="text-muted p-3">No active seating plan.</div>';
      return;
    }

    const allAllocations = Object.values(state.plan.studentLookup);
    const filtered = allAllocations.filter(alloc => {
      if (!query) return true;
      return alloc.student.rollNumber.toLowerCase().includes(query) ||
        alloc.student.name.toLowerCase().includes(query) ||
        alloc.student.branch.toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      resultsContainer.innerHTML = '<div class="text-muted p-3">No student matches your lookup query.</div>';
      return;
    }

    resultsContainer.innerHTML = filtered.slice(0, 30).map(alloc => {
      const isSelected = state.selectedLookupStudentId === alloc.student.id;
      return `
        <div class="lookup-item ${isSelected ? 'active' : ''}" onclick="app.selectLookupStudent('${alloc.student.id}')">
          <div>
            <div class="d-flex align-center gap-2">
              <span class="roll-code">${alloc.student.rollNumber}</span>
              <strong>${alloc.student.name}</strong>
            </div>
            <div class="text-xs text-muted mt-1">
              ${alloc.student.branch} • ${alloc.student.semester}
            </div>
          </div>
          <div class="text-right">
            <span class="badge badge-primary">${alloc.room.name}</span>
            <div class="text-xs font-bold mt-1">${alloc.seatNumber}</div>
          </div>
        </div>
      `;
    }).join('');

    // If student selected, render hall slip
    if (state.selectedLookupStudentId && state.plan.studentLookup[state.selectedLookupStudentId]) {
      renderHallSlip(state.plan.studentLookup[state.selectedLookupStudentId]);
    } else if (filtered.length > 0) {
      renderHallSlip(filtered[0]);
      state.selectedLookupStudentId = filtered[0].student.id;
    }
  }

  function renderHallSlip(alloc) {
    const slipBody = document.getElementById('hallSlipBody');
    const btnPrint = document.getElementById('btnPrintSingleSlip');
    btnPrint.disabled = false;

    slipBody.innerHTML = `
      <div class="slip-seat-highlight">
        <div class="slip-seat-label">Assigned Desk / Seat Number</div>
        <div class="slip-seat-code">${alloc.seatNumber}</div>
      </div>

      <div class="slip-info-grid">
        <div>
          <span class="text-xs text-muted uppercase">Candidate Name:</span>
          <div class="font-bold">${alloc.student.name}</div>
        </div>
        <div>
          <span class="text-xs text-muted uppercase">Roll Number:</span>
          <div><span class="roll-code">${alloc.student.rollNumber}</span></div>
        </div>
        <div>
          <span class="text-xs text-muted uppercase">Branch / Dept:</span>
          <div class="font-bold">${alloc.student.branch}</div>
        </div>
        <div>
          <span class="text-xs text-muted uppercase">Semester:</span>
          <div class="font-bold">${alloc.student.semester}</div>
        </div>
        <div>
          <span class="text-xs text-muted uppercase">Exam Venue:</span>
          <div class="font-bold" style="color:var(--navy-700)">${alloc.room.name} (${alloc.room.building})</div>
        </div>
        <div>
          <span class="text-xs text-muted uppercase">Exam Subject:</span>
          <div class="text-xs font-bold">${alloc.student.subject || 'All Scheduled Papers'}</div>
        </div>
      </div>

      <div style="background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: var(--radius-md); padding: 0.65rem; font-size: 0.72rem; color: #475569;">
        <strong>Important Instructions:</strong>
        Candidates must occupy their assigned desk at least 15 minutes before the exam commences. Possession of mobile phones or smartwatches is strictly prohibited.
      </div>
    `;
  }

  function renderOccupancyStats() {
    if (!state.plan) return;

    // Stats Overview Cards
    const statsContainer = document.getElementById('planStatsCards');
    const totalAllocated = state.plan.stats.totalAllocated;
    const totalCapacity = state.plan.stats.totalCapacity;
    const roomCount = state.plan.stats.roomCount;

    statsContainer.innerHTML = `
      <div class="metric-card">
        <div class="metric-icon metric-icon-blue">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        </div>
        <div class="metric-content">
          <span class="metric-label">Allocation Completion</span>
          <span class="metric-value">100%</span>
          <span class="metric-sub text-success">All ${totalAllocated} students assigned</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon metric-icon-emerald">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18"/><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/></svg>
        </div>
        <div class="metric-content">
          <span class="metric-label">Total Halls Utilized</span>
          <span class="metric-value">${roomCount} Rooms</span>
          <span class="metric-sub">${totalCapacity} available seats</span>
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon metric-icon-purple">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <div class="metric-content">
          <span class="metric-label">Seat Density Margin</span>
          <span class="metric-value">+${totalCapacity - totalAllocated} Seats</span>
          <span class="metric-sub">Buffer headroom available</span>
        </div>
      </div>
    `;

    // Branch Matrix Cross-Tabulation
    const matrixTable = document.getElementById('branchMatrixTable');
    const branches = Array.from(new Set(state.students.map(s => s.branch))).filter(Boolean);

    let theadHtml = `
      <thead>
        <tr>
          <th>Examination Room</th>
          <th>Capacity</th>
          <th>Total Seated</th>
          ${branches.map(b => `<th>${b.split('(')[1]?.replace(')', '') || b}</th>`).join('')}
          <th>Occupancy</th>
        </tr>
      </thead>
    `;

    let tbodyHtml = '<tbody>';
    Object.values(state.plan.roomPlans).forEach(rp => {
      const pct = Math.round((rp.allocatedCount / rp.room.capacity) * 100);
      tbodyHtml += `
        <tr>
          <td><strong>${rp.room.name}</strong> <span class="text-xs text-muted">(${rp.room.building})</span></td>
          <td>${rp.room.capacity}</td>
          <td><strong>${rp.allocatedCount}</strong></td>
          ${branches.map(b => `<td>${rp.branchCounts[b] || 0}</td>`).join('')}
          <td><span class="badge ${pct === 100 ? 'badge-primary' : 'badge-neutral'}">${pct}%</span></td>
        </tr>
      `;
    });
    tbodyHtml += '</tbody>';

    matrixTable.innerHTML = theadHtml + tbodyHtml;
  }

  // --- Render Reports View ---
  function renderReportsView() {
    if (!state.plan) {
      document.getElementById('printableDocument').innerHTML = `
        <div class="empty-state" style="padding:4rem;">
          <div class="empty-icon">🖨️</div>
          <h3>No Report to Display</h3>
          <p>Generate a seating plan first, then come back here to print door notices, attendance rosters, and master charts.</p>
          <button class="btn btn-primary mt-2" onclick="app.switchView('generator')">Go to Plan Generator</button>
        </div>`;
      return;
    }


    const container = document.getElementById('printableDocument');
    const activeRP = state.plan.roomPlans[state.activeRoomIdForPlan || Object.keys(state.plan.roomPlans)[0]];

    if (state.activeReportType === 'door-notice') {
      // Room Door Notice Sheet
      container.innerHTML = `
        <div class="print-sheet-header">
          <div class="print-institution">CENTRAL COLLEGE OF ENGINEERING & TECHNOLOGY</div>
          <div class="print-exam-name">MID-TERM SEMESTER EXAMINATION 2026</div>
          <div class="print-doc-title">EXAMINATION HALL DOOR NOTICE & SEATING ROSTER</div>
        </div>

        <div class="print-meta-grid">
          <div><strong>Hall / Venue:</strong> ${activeRP.room.name}</div>
          <div><strong>Building:</strong> ${activeRP.room.building}</div>
          <div><strong>Date & Session:</strong> ${state.plan.formattedDate}</div>
          <div><strong>Total Candidates:</strong> ${activeRP.allocatedCount}</div>
          <div><strong>Hall Capacity:</strong> ${activeRP.room.capacity} Seats</div>
          <div><strong>Invigilator:</strong> ___________________</div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <h4 style="font-size: 0.95rem; margin-bottom: 0.5rem; text-transform: uppercase;">Alphabetical Roll Call & Desk Allocation:</h4>
          <table class="data-table">
            <thead>
              <tr>
                <th width="80">Desk #</th>
                <th>Roll Number</th>
                <th>Candidate Name</th>
                <th>Branch</th>
                <th>Semester</th>
                <th>Subject</th>
              </tr>
            </thead>
            <tbody>
              ${activeRP.seats.map(seat => `
                <tr>
                  <td><strong>${seat.seatNumber}</strong></td>
                  <td><span class="roll-code">${seat.student.rollNumber}</span></td>
                  <td><strong>${seat.student.name}</strong></td>
                  <td>${seat.student.branch}</td>
                  <td>${seat.student.semester}</td>
                  <td class="text-xs">${seat.student.subject}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <div class="print-signatures-row">
          <div>Prepared By: Examination Cell</div>
          <div>Center Superintendent Signature: __________________</div>
        </div>
      `;
    } else if (state.activeReportType === 'invigilator-sheet') {
      // Invigilator Attendance Roster
      container.innerHTML = `
        <div class="print-sheet-header">
          <div class="print-institution">CENTRAL COLLEGE OF ENGINEERING & TECHNOLOGY</div>
          <div class="print-exam-name">OFFICIAL INVIGILATOR ATTENDANCE & VERIFICATION ROSTER</div>
          <div class="print-doc-title">VENUE: ${activeRP.room.name} (${activeRP.room.building})</div>
        </div>

        <div class="print-meta-grid">
          <div><strong>Hall Name:</strong> ${activeRP.room.name}</div>
          <div><strong>Session:</strong> Morning (09:30 AM – 12:30 PM)</div>
          <div><strong>Registered Candidates:</strong> ${activeRP.allocatedCount}</div>
          <div><strong>Present:</strong> _____</div>
          <div><strong>Absent:</strong> _____</div>
          <div><strong>Answer Booklets Issued:</strong> _____</div>
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th width="70">Seat #</th>
              <th>Roll Number</th>
              <th>Candidate Name</th>
              <th>Subject</th>
              <th width="140">Candidate Signature</th>
              <th width="120">Answer Book #</th>
            </tr>
          </thead>
          <tbody>
            ${activeRP.seats.map(seat => `
              <tr>
                <td><strong>${seat.seatNumber}</strong></td>
                <td><span class="roll-code">${seat.student.rollNumber}</span></td>
                <td><strong>${seat.student.name}</strong></td>
                <td class="text-xs">${seat.student.subject}</td>
                <td style="border-bottom: 1px dashed #000; height: 35px;"></td>
                <td style="border-bottom: 1px dashed #000;"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="print-signatures-row">
          <div>Invigilator 1 Signature: __________________</div>
          <div>Invigilator 2 Signature: __________________</div>
        </div>
      `;
    } else if (state.activeReportType === 'master-chart') {
      // College Master Notice Board Chart
      container.innerHTML = `
        <div class="print-sheet-header">
          <div class="print-institution">CENTRAL COLLEGE OF ENGINEERING & TECHNOLOGY</div>
          <div class="print-exam-name">MASTER EXAMINATION SEATING ALLOCATION CHART</div>
          <div class="print-doc-title">ALL REGISTERED CANDIDATES & HALL DIRECTORY</div>
        </div>

        <div class="print-meta-grid">
          <div><strong>Total Examinees:</strong> ${state.plan.stats.totalAllocated}</div>
          <div><strong>Exam Venues:</strong> ${state.plan.stats.roomCount} Halls</div>
          <div><strong>Generated:</strong> ${state.plan.formattedDate}</div>
        </div>

        <table class="data-table">
          <thead>
            <tr>
              <th>Roll Number</th>
              <th>Student Name</th>
              <th>Branch / Department</th>
              <th>Exam Hall</th>
              <th>Building / Block</th>
              <th>Assigned Seat #</th>
            </tr>
          </thead>
          <tbody>
            ${Object.values(state.plan.studentLookup).map(alloc => `
              <tr>
                <td><span class="roll-code">${alloc.student.rollNumber}</span></td>
                <td><strong>${alloc.student.name}</strong></td>
                <td>${alloc.student.branch}</td>
                <td><strong>${alloc.room.name}</strong></td>
                <td>${alloc.room.building}</td>
                <td><strong class="roll-code">${alloc.seatNumber}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>

        <div class="print-signatures-row">
          <div>Controller of Examinations: __________________</div>
          <div>Date: __________________</div>
        </div>
      `;
    }
  }

  // --- Seat Detail Modal ---
  function openSeatDetailModal(seat, room) {
    const dialog = document.getElementById('seatDetailModal');
    document.getElementById('seatModalBadge').textContent = seat.seatNumber;
    document.getElementById('seatModalTitle').textContent = `Desk in ${room.name}`;

    const color = getBranchColor(seat.student.branch);

    document.getElementById('seatModalContent').innerHTML = `
      <div style="background: #f8fafc; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem;">
        <div class="d-flex align-center gap-2 mb-2">
          <span class="roll-code" style="font-size: 0.95rem;">${seat.student.rollNumber}</span>
          <strong style="font-size: 1.05rem;">${seat.student.name}</strong>
        </div>
        <div class="text-xs text-muted mb-2">
          ${seat.student.email || 'student@college.edu'}
        </div>
        <div class="d-flex align-center gap-2">
          <span class="badge" style="background: ${color}22; color: ${color}; border: 1px solid ${color}44;">
            ${seat.student.branch}
          </span>
          <span class="badge badge-neutral">${seat.student.semester}</span>
        </div>
      </div>

      <div class="feasibility-metrics text-sm">
        <div class="feasibility-row">
          <span class="text-muted">Exam Paper:</span>
          <strong>${seat.student.subject || 'Standard'}</strong>
        </div>
        <div class="feasibility-row">
          <span class="text-muted">Grid Position:</span>
          <strong>Row ${seat.rowIndex + 1}, Col ${seat.colIndex + 1}</strong>
        </div>
        <div class="feasibility-row">
          <span class="text-muted">Hall Location:</span>
          <strong>${room.building}</strong>
        </div>
      </div>
    `;

    dialog.showModal();
  }

  // =========================================================================
  // CRUD OPERATIONS: STUDENTS
  // =========================================================================
  function openAddStudentModal() {
    const dialog = document.getElementById('studentModal');
    document.getElementById('studentModalTitle').textContent = 'Add New Student';
    document.getElementById('studentFormId').value = '';
    document.getElementById('studentForm').reset();
    document.getElementById('studentEligible').checked = true;
    dialog.showModal();
  }

  function openEditStudentModal(id) {
    const student = state.students.find(s => s.id === id);
    if (!student) return;

    const dialog = document.getElementById('studentModal');
    document.getElementById('studentModalTitle').textContent = 'Edit Student Details';
    document.getElementById('studentFormId').value = student.id;
    document.getElementById('studentRoll').value = student.rollNumber;
    document.getElementById('studentName').value = student.name;
    document.getElementById('studentBranch').value = student.branch;
    document.getElementById('studentSemester').value = student.semester;
    document.getElementById('studentSubject').value = student.subject || '';
    document.getElementById('studentEligible').checked = !!student.eligible;
    dialog.showModal();
  }

  function handleSaveStudent(e) {
    e.preventDefault();
    const id = document.getElementById('studentFormId').value;
    const roll = document.getElementById('studentRoll').value.trim();
    const name = document.getElementById('studentName').value.trim();
    const branch = document.getElementById('studentBranch').value.trim();
    const semester = document.getElementById('studentSemester').value;
    const subject = document.getElementById('studentSubject').value.trim();
    const eligible = document.getElementById('studentEligible').checked;

    if (!roll || !name || !branch) {
      showToast('Please fill all required student fields.', 'error');
      return;
    }

    // Check duplicate roll number
    const existing = state.students.find(s => s.rollNumber.toLowerCase() === roll.toLowerCase() && s.id !== id);
    if (existing) {
      showToast(`Roll number "${roll}" already exists in records!`, 'error');
      return;
    }

    if (id) {
      // Update
      const idx = state.students.findIndex(s => s.id === id);
      if (idx !== -1) {
        state.students[idx] = {
          ...state.students[idx],
          rollNumber: roll,
          name,
          branch,
          semester,
          subject,
          eligible
        };
        showToast(`Student ${name} updated successfully.`, 'success');
      }
    } else {
      // Add new
      const newStudent = {
        id: `stu_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        rollNumber: roll,
        name,
        branch,
        semester,
        subject,
        eligible
      };
      state.students.unshift(newStudent);
      showToast(`Student ${name} added successfully.`, 'success');
    }

    saveStudents();
    document.getElementById('studentModal').close();
    renderStudents();
    renderDashboard();
  }

  function deleteStudent(id) {
    const student = state.students.find(s => s.id === id);
    if (!student) return;

    openConfirmDialog({
      title: 'Delete Student',
      message: `Are you sure you want to remove student "${student.name}" (${student.rollNumber})?`,
      onConfirm: () => {
        state.students = state.students.filter(s => s.id !== id);
        state.selectedStudentIds.delete(id);
        saveStudents();
        showToast('Student deleted.', 'info');
        renderStudents();
        renderDashboard();
      }
    });
  }

  function toggleStudentEligibility(id) {
    const student = state.students.find(s => s.id === id);
    if (!student) return;
    student.eligible = !student.eligible;
    saveStudents();
    renderStudents();
    renderDashboard();
  }

  // =========================================================================
  // CRUD OPERATIONS: ROOMS
  // =========================================================================
  function openAddRoomModal() {
    const dialog = document.getElementById('roomModal');
    document.getElementById('roomModalTitle').textContent = 'Add Exam Room';
    document.getElementById('roomFormId').value = '';
    document.getElementById('roomForm').reset();
    document.getElementById('roomRows').value = 5;
    document.getElementById('roomCols').value = 6;
    document.getElementById('roomCapacity').value = 30;
    document.getElementById('roomAvailable').checked = true;
    dialog.showModal();
  }

  function openEditRoomModal(id) {
    const room = state.rooms.find(r => r.id === id);
    if (!room) return;

    const dialog = document.getElementById('roomModal');
    document.getElementById('roomModalTitle').textContent = 'Edit Exam Room';
    document.getElementById('roomFormId').value = room.id;
    document.getElementById('roomName').value = room.name;
    document.getElementById('roomBuilding').value = room.building;
    document.getElementById('roomRows').value = room.rows || 5;
    document.getElementById('roomCols').value = room.cols || 6;
    document.getElementById('roomCapacity').value = room.capacity;
    document.getElementById('roomNotes').value = room.notes || '';
    document.getElementById('roomAvailable').checked = !!room.available;
    dialog.showModal();
  }

  function handleSaveRoom(e) {
    e.preventDefault();
    const id = document.getElementById('roomFormId').value;
    const name = document.getElementById('roomName').value.trim();
    const building = document.getElementById('roomBuilding').value.trim();
    const rows = Number(document.getElementById('roomRows').value) || 5;
    const cols = Number(document.getElementById('roomCols').value) || 6;
    const capacity = Number(document.getElementById('roomCapacity').value) || (rows * cols);
    const notes = document.getElementById('roomNotes').value.trim();
    const available = document.getElementById('roomAvailable').checked;

    if (!name || !building || capacity <= 0) {
      showToast('Please enter valid room details.', 'error');
      return;
    }

    if (id) {
      const idx = state.rooms.findIndex(r => r.id === id);
      if (idx !== -1) {
        state.rooms[idx] = {
          ...state.rooms[idx],
          name,
          building,
          rows,
          cols,
          capacity,
          notes,
          available
        };
        showToast(`Room ${name} updated.`, 'success');
      }
    } else {
      const newRoom = {
        id: `room_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        name,
        building,
        rows,
        cols,
        capacity,
        notes,
        available
      };
      state.rooms.push(newRoom);
      showToast(`Room ${name} added successfully.`, 'success');
    }

    saveRooms();
    document.getElementById('roomModal').close();
    renderRooms();
    renderDashboard();
  }

  function deleteRoom(id) {
    const room = state.rooms.find(r => r.id === id);
    if (!room) return;

    openConfirmDialog({
      title: 'Delete Room',
      message: `Are you sure you want to delete "${room.name}" (${room.building})?`,
      onConfirm: () => {
        state.rooms = state.rooms.filter(r => r.id !== id);
        saveRooms();
        showToast('Room deleted.', 'info');
        renderRooms();
        renderDashboard();
      }
    });
  }

  function toggleRoomAvailability(id) {
    const room = state.rooms.find(r => r.id === id);
    if (!room) return;
    room.available = !room.available;
    saveRooms();
    renderRooms();
    renderDashboard();
  }

  // =========================================================================
  // FILE UPLOAD & PARSING (EXCEL & CSV WITH COLUMN MAPPING)
  // =========================================================================

  // Pure client-side CSV parser fallback
  function parseCSV(text) {
    const lines = text.split(/\r\n|\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];

    return lines.map(line => {
      const row = [];
      let inQuotes = false;
      let current = '';

      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' || char === "'") {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          row.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      row.push(current.trim());
      return row;
    });
  }

  function handleFileRead(file, type) {
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');

    const reader = new FileReader();

    if (isExcel && typeof window.XLSX !== 'undefined') {
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = window.XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonRows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

          processParsedRows(jsonRows, type, file.name);
        } catch (err) {
          console.error('Error parsing Excel:', err);
          showToast('Failed to parse Excel file. Please verify format.', 'error');
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const rows = parseCSV(text);
          processParsedRows(rows, type, file.name);
        } catch (err) {
          console.error('Error parsing CSV:', err);
          showToast('Failed to parse CSV file.', 'error');
        }
      };
      reader.readAsText(file);
    }
  }

  function processParsedRows(rows, type, fileName) {
    if (!rows || rows.length < 2) {
      showToast('File contains insufficient rows or no data.', 'error');
      return;
    }

    const headers = rows[0].map(h => String(h || '').trim());
    const dataRows = rows.slice(1).filter(r => r.some(cell => String(cell || '').trim().length > 0));

    state.uploadCache = {
      type,
      fileName,
      headers,
      rawData: dataRows,
      mappedCols: {}
    };

    if (type === 'students') {
      setupStudentColumnMapping(headers, dataRows, fileName);
    } else if (type === 'rooms') {
      setupRoomColumnMapping(headers, dataRows, fileName);
    }
  }

  function setupStudentColumnMapping(headers, dataRows, fileName) {
    document.getElementById('studentsChosenFileName').textContent = `📄 Selected: ${fileName} (${dataRows.length} rows)`;
    document.getElementById('studentsMappingSection').style.display = 'block';

    const selects = {
      roll: document.getElementById('mapStudentRoll'),
      name: document.getElementById('mapStudentName'),
      branch: document.getElementById('mapStudentBranch'),
      sem: document.getElementById('mapStudentSemester'),
      sub: document.getElementById('mapStudentSubject')
    };

    // Populate header options
    Object.values(selects).forEach(sel => {
      sel.innerHTML = `<option value="">-- Select Column --</option>` +
        headers.map((h, idx) => `<option value="${idx}">${h}</option>`).join('');
    });

    // Auto-map heuristics
    headers.forEach((h, idx) => {
      const lower = h.toLowerCase();
      if (lower.includes('roll') || lower.includes('reg') || lower.includes('id')) selects.roll.value = idx;
      else if (lower.includes('name') || lower.includes('student')) selects.name.value = idx;
      else if (lower.includes('branch') || lower.includes('dept') || lower.includes('course')) selects.branch.value = idx;
      else if (lower.includes('sem') || lower.includes('year')) selects.sem.value = idx;
      else if (lower.includes('sub') || lower.includes('paper') || lower.includes('exam')) selects.sub.value = idx;
    });

    validateStudentMappingPreview();

    // Attach listeners
    Object.values(selects).forEach(sel => {
      sel.onchange = validateStudentMappingPreview;
    });
  }

  function validateStudentMappingPreview() {
    const rollCol = document.getElementById('mapStudentRoll').value;
    const nameCol = document.getElementById('mapStudentName').value;
    const branchCol = document.getElementById('mapStudentBranch').value;
    const semCol = document.getElementById('mapStudentSemester').value;
    const subCol = document.getElementById('mapStudentSubject').value;

    const banner = document.getElementById('studentsValidationBanner');
    const btnImport = document.getElementById('btnConfirmStudentImport');
    const tableHead = document.getElementById('studentsPreviewHead');
    const tableBody = document.getElementById('studentsPreviewBody');

    if (rollCol === '' || nameCol === '' || branchCol === '') {
      banner.className = 'upload-validation-banner alert alert-warning';
      banner.innerHTML = '⚠️ Please map the required columns: Roll Number, Full Name, and Branch/Dept.';
      btnImport.disabled = true;
      return;
    }

    banner.className = 'upload-validation-banner alert alert-success';
    banner.innerHTML = `✅ Mapping valid! Ready to import ${state.uploadCache.rawData.length} rows.`;
    btnImport.disabled = false;

    // Render Preview Table
    tableHead.innerHTML = `
      <tr>
        <th>Roll No</th>
        <th>Full Name</th>
        <th>Branch</th>
        <th>Semester</th>
        <th>Subject</th>
      </tr>
    `;

    tableBody.innerHTML = state.uploadCache.rawData.slice(0, 5).map(row => `
      <tr>
        <td><strong>${row[rollCol] || '—'}</strong></td>
        <td>${row[nameCol] || '—'}</td>
        <td>${row[branchCol] || '—'}</td>
        <td>${row[semCol] || 'Sem 4'}</td>
        <td>${row[subCol] || '—'}</td>
      </tr>
    `).join('');
  }

  function confirmStudentImport() {
    const rollCol = document.getElementById('mapStudentRoll').value;
    const nameCol = document.getElementById('mapStudentName').value;
    const branchCol = document.getElementById('mapStudentBranch').value;
    const semCol = document.getElementById('mapStudentSemester').value;
    const subCol = document.getElementById('mapStudentSubject').value;
    const importMode = document.querySelector('input[name="studentImportMode"]:checked').value;

    const imported = [];
    let skipped = 0;

    state.uploadCache.rawData.forEach((row, idx) => {
      const roll = String(row[rollCol] || '').trim();
      const name = String(row[nameCol] || '').trim();
      const branch = String(row[branchCol] || '').trim();
      const semester = semCol !== '' ? String(row[semCol] || 'Sem 4').trim() : 'Sem 4';
      const subject = subCol !== '' ? String(row[subCol] || '').trim() : '';

      if (!roll || !name) {
        skipped++;
        return;
      }

      imported.push({
        id: `stu_imp_${Date.now()}_${idx}`,
        rollNumber: roll,
        name,
        branch: branch || 'General',
        semester,
        subject,
        eligible: true
      });
    });

    if (importMode === 'REPLACE') {
      state.students = imported;
    } else {
      // Append mode with duplicate roll check
      const existingRolls = new Set(state.students.map(s => s.rollNumber.toLowerCase()));
      let dups = 0;
      imported.forEach(s => {
        if (!existingRolls.has(s.rollNumber.toLowerCase())) {
          state.students.push(s);
          existingRolls.add(s.rollNumber.toLowerCase());
        } else {
          dups++;
        }
      });
    }

    saveStudents();
    document.getElementById('uploadStudentsModal').close();
    showToast(`Successfully imported ${imported.length} student records!`, 'success');
    renderStudents();
    renderDashboard();
  }

  // --- Room Upload Mapping ---
  function setupRoomColumnMapping(headers, dataRows, fileName) {
    document.getElementById('roomsChosenFileName').textContent = `📄 Selected: ${fileName} (${dataRows.length} rows)`;
    document.getElementById('roomsMappingSection').style.display = 'block';

    const selects = {
      name: document.getElementById('mapRoomName'),
      bldg: document.getElementById('mapRoomBuilding'),
      cap: document.getElementById('mapRoomCapacity'),
      rows: document.getElementById('mapRoomRows'),
      cols: document.getElementById('mapRoomCols')
    };

    Object.values(selects).forEach(sel => {
      sel.innerHTML = `<option value="">-- Select Column --</option>` +
        headers.map((h, idx) => `<option value="${idx}">${h}</option>`).join('');
    });

    headers.forEach((h, idx) => {
      const lower = h.toLowerCase();
      if (lower.includes('name') || lower.includes('room') || lower.includes('hall')) selects.name.value = idx;
      else if (lower.includes('build') || lower.includes('block')) selects.bldg.value = idx;
      else if (lower.includes('cap') || lower.includes('seat')) selects.cap.value = idx;
      else if (lower.includes('row')) selects.rows.value = idx;
      else if (lower.includes('col')) selects.cols.value = idx;
    });

    validateRoomMapping();
    Object.values(selects).forEach(sel => sel.onchange = validateRoomMapping);
  }

  function validateRoomMapping() {
    const nameCol = document.getElementById('mapRoomName').value;
    const bldgCol = document.getElementById('mapRoomBuilding').value;
    const capCol = document.getElementById('mapRoomCapacity').value;

    const banner = document.getElementById('roomsValidationBanner');
    const btnImport = document.getElementById('btnConfirmRoomImport');

    if (nameCol === '' || capCol === '') {
      banner.className = 'upload-validation-banner alert alert-warning';
      banner.innerHTML = '⚠️ Please map Room Name and Capacity.';
      btnImport.disabled = true;
      return;
    }

    banner.className = 'upload-validation-banner alert alert-success';
    banner.innerHTML = `✅ Ready to import ${state.uploadCache.rawData.length} examination halls.`;
    btnImport.disabled = false;
  }

  function confirmRoomImport() {
    const nameCol = document.getElementById('mapRoomName').value;
    const bldgCol = document.getElementById('mapRoomBuilding').value;
    const capCol = document.getElementById('mapRoomCapacity').value;
    const rowsCol = document.getElementById('mapRoomRows').value;
    const colsCol = document.getElementById('mapRoomCols').value;
    const importMode = document.querySelector('input[name="roomImportMode"]:checked').value;

    const imported = [];
    state.uploadCache.rawData.forEach((row, idx) => {
      const name = String(row[nameCol] || '').trim();
      const building = bldgCol !== '' ? String(row[bldgCol] || 'Main Complex').trim() : 'Main Complex';
      const cap = Number(row[capCol]) || 20;
      const rows = rowsCol !== '' ? Number(row[rowsCol]) || 4 : 4;
      const cols = colsCol !== '' ? Number(row[colsCol]) || Math.ceil(cap / rows) : Math.ceil(cap / rows);

      if (name) {
        imported.push({
          id: `room_imp_${Date.now()}_${idx}`,
          name,
          building,
          capacity: cap,
          rows,
          cols,
          available: true
        });
      }
    });

    if (importMode === 'REPLACE') {
      state.rooms = imported;
    } else {
      imported.forEach(r => state.rooms.push(r));
    }

    saveRooms();
    document.getElementById('uploadRoomsModal').close();
    showToast(`Imported ${imported.length} exam rooms successfully!`, 'success');
    renderRooms();
    renderDashboard();
  }

  // =========================================================================
  // EXPORT FUNCTIONS (CSV & PRINT)
  // =========================================================================
  function downloadCSV(csvContent, filename) {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function exportPlanToCSV() {
    if (!state.plan || !state.plan.studentLookup) {
      showToast('No active plan generated yet to export.', 'error');
      return;
    }

    const headers = ['Roll Number', 'Candidate Name', 'Branch', 'Semester', 'Exam Subject', 'Exam Hall', 'Building', 'Seat Number'];
    const rows = Object.values(state.plan.studentLookup).map(alloc => [
      `"${alloc.student.rollNumber}"`,
      `"${alloc.student.name}"`,
      `"${alloc.student.branch}"`,
      `"${alloc.student.semester}"`,
      `"${alloc.student.subject || ''}"`,
      `"${alloc.room.name}"`,
      `"${alloc.room.building}"`,
      `"${alloc.seatNumber}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadCSV(csvContent, `ExamSeat_Master_Plan_${Date.now()}.csv`);
    showToast('Master seating plan CSV downloaded.', 'success');
  }

  function downloadStudentSampleTemplate() {
    const sampleCSV = `Roll Number,Full Name,Branch,Semester,Subject\n23CSE001,Aarav Sharma,Computer Science (CSE),Sem 4,CS401: Algorithms\n23ECE002,Aditi Patel,Electronics (ECE),Sem 4,EC402: Microprocessors\n23ME003,Aryan Gupta,Mechanical (ME),Sem 4,ME403: Thermodynamics\n23IT004,Bhavya Iyer,Information Tech (IT),Sem 4,IT404: Web Systems`;
    downloadCSV(sampleCSV, 'ExamSeat_Sample_Students.csv');
  }

  function downloadRoomSampleTemplate() {
    const sampleCSV = `Room Name,Building,Capacity,Rows,Columns,Notes\nLHC-101,Main Complex,24,4,6,Air conditioned\nLH-204,Science Block,20,4,5,CCTV Enabled\nLab-3,Tech Center,16,4,4,Computers installed`;
    downloadCSV(sampleCSV, 'ExamSeat_Sample_Rooms.csv');
  }

  function clearAllData() {
    openConfirmDialog({
      title: 'Clear All Data',
      message: 'This will permanently delete all students, rooms, and seating plans stored in this browser. Are you sure?',
      onConfirm: () => {
        localStorage.removeItem(STORAGE_KEYS.STUDENTS);
        localStorage.removeItem(STORAGE_KEYS.ROOMS);
        localStorage.removeItem(STORAGE_KEYS.PLAN);
        state.students = [];
        state.rooms = [];
        state.plan = null;
        state.selectedStudentIds.clear();
        state.activeRoomIdForPlan = null;
        showToast('All data cleared successfully.', 'success');
        switchView('dashboard');
      }
    });
  }

  // --- Mobile Sidebar Controls ---
  function openMobileSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('active');
  }

  function closeMobileSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('active');
  }

  // =========================================================================
  // ATTACH EVENT LISTENERS
  // =========================================================================
  function initEventListeners() {
    // Nav Click Handlers
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Mobile Sidebar Toggles
    document.getElementById('btnSidebarOpen').addEventListener('click', openMobileSidebar);
    document.getElementById('btnSidebarClose').addEventListener('click', closeMobileSidebar);
    document.getElementById('sidebarOverlay').addEventListener('click', closeMobileSidebar);

    // Header Quick Action Buttons
    document.getElementById('btnResetDemoData').addEventListener('click', clearAllData);
    document.getElementById('btnHeaderGenerate').addEventListener('click', () => switchView('generator'));
    document.getElementById('btnQuickLookup').addEventListener('click', () => {
      switchView('plans');
      setPlanSubTab('lookup');
    });

    // Students Table Controls
    document.getElementById('studentSearchInput').addEventListener('input', renderStudents);
    document.getElementById('filterStudentBranch').addEventListener('change', renderStudents);
    document.getElementById('filterStudentSemester').addEventListener('change', renderStudents);
    document.getElementById('filterStudentStatus').addEventListener('change', renderStudents);
    document.getElementById('btnClearStudentFilters').addEventListener('click', () => {
      document.getElementById('studentSearchInput').value = '';
      document.getElementById('filterStudentBranch').value = 'ALL';
      document.getElementById('filterStudentSemester').value = 'ALL';
      document.getElementById('filterStudentStatus').value = 'ALL';
      renderStudents();
    });

    // Select All Visible Students Checkbox
    document.getElementById('selectAllStudents').addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.student-select-cb').forEach(cb => {
        cb.checked = isChecked;
        if (isChecked) state.selectedStudentIds.add(cb.dataset.id);
        else state.selectedStudentIds.delete(cb.dataset.id);
      });
      renderStudents();
    });

    // Individual Student Selection Checkboxes (Delegation)
    document.getElementById('studentsTableBody').addEventListener('change', (e) => {
      if (e.target.classList.contains('student-select-cb')) {
        const id = e.target.dataset.id;
        if (e.target.checked) state.selectedStudentIds.add(id);
        else state.selectedStudentIds.delete(id);
        updateBulkStudentRibbon();
      }
    });

    // Bulk Student Actions
    document.getElementById('btnBulkMakeEligible').addEventListener('click', () => {
      state.students.forEach(s => {
        if (state.selectedStudentIds.has(s.id)) s.eligible = true;
      });
      state.selectedStudentIds.clear();
      saveStudents();
      showToast('Selected students marked as eligible.', 'success');
      renderStudents();
      renderDashboard();
    });

    document.getElementById('btnBulkMakeExcluded').addEventListener('click', () => {
      state.students.forEach(s => {
        if (state.selectedStudentIds.has(s.id)) s.eligible = false;
      });
      state.selectedStudentIds.clear();
      saveStudents();
      showToast('Selected students excluded from exam.', 'info');
      renderStudents();
      renderDashboard();
    });

    document.getElementById('btnBulkDeleteStudents').addEventListener('click', () => {
      const count = state.selectedStudentIds.size;
      openConfirmDialog({
        title: 'Delete Selected Students',
        message: `Are you sure you want to delete ${count} selected student records?`,
        onConfirm: () => {
          state.students = state.students.filter(s => !state.selectedStudentIds.has(s.id));
          state.selectedStudentIds.clear();
          saveStudents();
          showToast(`Deleted ${count} students.`, 'info');
          renderStudents();
          renderDashboard();
        }
      });
    });

    // Student Modals
    document.getElementById('btnAddStudentModalOpen').addEventListener('click', openAddStudentModal);
    document.getElementById('btnStudentModalClose').addEventListener('click', () => document.getElementById('studentModal').close());
    document.getElementById('btnStudentModalCancel').addEventListener('click', () => document.getElementById('studentModal').close());
    document.getElementById('studentForm').addEventListener('submit', handleSaveStudent);

    // Upload Students Modal
    document.getElementById('btnUploadStudentsModalOpen').addEventListener('click', () => {
      document.getElementById('studentsMappingSection').style.display = 'none';
      document.getElementById('studentsChosenFileName').textContent = '';
      document.getElementById('uploadStudentsModal').showModal();
    });
    document.getElementById('btnUploadStudentsModalClose').addEventListener('click', () => document.getElementById('uploadStudentsModal').close());
    document.getElementById('btnUploadStudentsCancel').addEventListener('click', () => document.getElementById('uploadStudentsModal').close());
    document.getElementById('btnDownloadStudentTemplate').addEventListener('click', downloadStudentSampleTemplate);
    document.getElementById('btnConfirmStudentImport').addEventListener('click', confirmStudentImport);

    const studentFileInput = document.getElementById('studentsFileInput');
    studentFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileRead(e.target.files[0], 'students');
      }
    });

    // Drag and Drop for Students Dropzone
    const studentDropzone = document.getElementById('studentsDropzone');
    studentDropzone.addEventListener('dragover', (e) => { e.preventDefault(); studentDropzone.classList.add('drag-active'); });
    studentDropzone.addEventListener('dragleave', () => studentDropzone.classList.remove('drag-active'));
    studentDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      studentDropzone.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileRead(e.dataTransfer.files[0], 'students');
      }
    });

    // Rooms Controls
    document.getElementById('roomSearchInput').addEventListener('input', renderRooms);
    document.getElementById('filterRoomBuilding').addEventListener('change', renderRooms);
    document.getElementById('filterRoomStatus').addEventListener('change', renderRooms);
    document.getElementById('btnAddRoomModalOpen').addEventListener('click', openAddRoomModal);
    document.getElementById('btnRoomModalClose').addEventListener('click', () => document.getElementById('roomModal').close());
    document.getElementById('btnRoomModalCancel').addEventListener('click', () => document.getElementById('roomModal').close());
    document.getElementById('roomForm').addEventListener('submit', handleSaveRoom);
    document.getElementById('btnDownloadRoomTemplate').addEventListener('click', downloadRoomSampleTemplate);

    // Upload Rooms Modal
    document.getElementById('btnUploadRoomsModalOpen').addEventListener('click', () => {
      document.getElementById('roomsMappingSection').style.display = 'none';
      document.getElementById('roomsChosenFileName').textContent = '';
      document.getElementById('uploadRoomsModal').showModal();
    });
    document.getElementById('btnUploadRoomsModalClose').addEventListener('click', () => document.getElementById('uploadRoomsModal').close());
    document.getElementById('btnUploadRoomsCancel').addEventListener('click', () => document.getElementById('uploadRoomsModal').close());
    document.getElementById('btnConfirmRoomImport').addEventListener('click', confirmRoomImport);

    const roomsFileInput = document.getElementById('roomsFileInput');
    roomsFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFileRead(e.target.files[0], 'rooms');
      }
    });

    const roomDropzone = document.getElementById('roomsDropzone');
    roomDropzone.addEventListener('dragover', (e) => { e.preventDefault(); roomDropzone.classList.add('drag-active'); });
    roomDropzone.addEventListener('dragleave', () => roomDropzone.classList.remove('drag-active'));
    roomDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      roomDropzone.classList.remove('drag-active');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileRead(e.dataTransfer.files[0], 'rooms');
      }
    });

    // Generator Toggles
    document.getElementById('btnToggleAllBranches').addEventListener('click', () => {
      const cbs = document.querySelectorAll('.gen-branch-cb');
      const someUnchecked = Array.from(cbs).some(cb => !cb.checked);
      cbs.forEach(cb => cb.checked = someUnchecked);
      updateGeneratorFeasibility();
    });

    document.getElementById('btnToggleAllSemesters').addEventListener('click', () => {
      const cbs = document.querySelectorAll('.gen-sem-cb');
      const someUnchecked = Array.from(cbs).some(cb => !cb.checked);
      cbs.forEach(cb => cb.checked = someUnchecked);
      updateGeneratorFeasibility();
    });

    document.getElementById('btnToggleAllGenRooms').addEventListener('click', () => {
      const cbs = document.querySelectorAll('.gen-room-cb');
      const someUnchecked = Array.from(cbs).some(cb => !cb.checked);
      cbs.forEach(cb => cb.checked = someUnchecked);
      updateGeneratorFeasibility();
    });

    // Execute Seating Plan Generation
    document.getElementById('btnExecuteGenerate').addEventListener('click', () => {
      const selectedBranches = Array.from(document.querySelectorAll('.gen-branch-cb:checked')).map(cb => cb.value);
      const selectedSemesters = Array.from(document.querySelectorAll('.gen-sem-cb:checked')).map(cb => cb.value);
      const selectedRoomIds = Array.from(document.querySelectorAll('.gen-room-cb:checked')).map(cb => cb.value);
      const sortStrategy = document.getElementById('genSortStrategy').value;
      const allocationStrategy = document.querySelector('input[name="genStrategy"]:checked').value;
      const seatPrefixFormat = document.getElementById('genSeatPrefix').value;

      const result = executePlanGeneration({
        selectedBranches,
        selectedSemesters,
        selectedRoomIds,
        sortStrategy,
        allocationStrategy,
        seatPrefixFormat
      });

      if (result.success) {
        showToast('🎉 Exam seating plan generated successfully!', 'success');
        switchView('plans');
      } else {
        showToast(result.error || 'Failed to generate plan.', 'error');
      }
    });

    // Plans Sub-nav Tabs
    document.querySelectorAll('.subnav-tab').forEach(tab => {
      tab.addEventListener('click', () => setPlanSubTab(tab.dataset.plantab));
    });

    // Student Lookup Search
    document.getElementById('lookupSearchInput').addEventListener('input', renderStudentLookup);

    // Seat Detail Modal
    document.getElementById('btnSeatModalClose').addEventListener('click', () => document.getElementById('seatDetailModal').close());
    document.getElementById('btnSeatModalDone').addEventListener('click', () => document.getElementById('seatDetailModal').close());

    // Exports and Printing
    document.getElementById('btnExportCSVPlan').addEventListener('click', exportPlanToCSV);
    document.getElementById('btnExportAllCSV').addEventListener('click', exportPlanToCSV);
    document.getElementById('btnPrintCurrentRoomReport').addEventListener('click', () => {
      switchView('reports');
      setReportType('door-notice');
      setTimeout(() => window.print(), 350);
    });
    document.getElementById('btnPrintRosterOnly').addEventListener('click', () => {
      switchView('reports');
      setReportType('invigilator-sheet');
      setTimeout(() => window.print(), 350);
    });
    document.getElementById('btnTriggerPrintReport').addEventListener('click', () => window.print());
    document.getElementById('btnPrintSingleSlip').addEventListener('click', () => window.print());

    // Report Type Switcher
    document.querySelectorAll('.report-type-btn').forEach(btn => {
      btn.addEventListener('click', () => setReportType(btn.dataset.report));
    });
  }

  function setPlanSubTab(tabName) {
    state.activePlanSubTab = tabName;
    renderPlansView();
  }

  function setActivePlanRoom(roomId) {
    state.activeRoomIdForPlan = roomId;
    renderPlansView();
  }

  function selectLookupStudent(studentId) {
    state.selectedLookupStudentId = studentId;
    renderStudentLookup();
  }

  function setReportType(reportType) {
    state.activeReportType = reportType;
    document.querySelectorAll('.report-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.report === reportType);
    });
    renderReportsView();
  }

  // =========================================================================
  // PUBLIC API EXPOSED ON WINDOW.APP
  // =========================================================================
  window.app = {
    switchView,
    openAddRoomModal,
    openEditRoomModal,
    deleteRoom,
    toggleRoomAvailability,
    openAddStudentModal,
    openEditStudentModal,
    deleteStudent,
    toggleStudentEligibility,
    updateGeneratorFeasibility,
    setActivePlanRoom,
    selectLookupStudent,
    resetStudentFilters: () => {
      document.getElementById('studentSearchInput').value = '';
      document.getElementById('filterStudentBranch').value = 'ALL';
      document.getElementById('filterStudentSemester').value = 'ALL';
      document.getElementById('filterStudentStatus').value = 'ALL';
      renderStudents();
    }
  };

  // =========================================================================
  // APPLICATION INIT
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    loadState();
    initEventListeners();
    switchView('dashboard');
  });

})();
