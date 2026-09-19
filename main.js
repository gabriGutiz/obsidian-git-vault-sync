const {
  Plugin,
  PluginSettingTab,
  ItemView,
  Setting,
  Notice,
  setIcon,
} = require("obsidian");

const { execFile } = require("child_process");

const VIEW_TYPE_GIT_AUTO_SYNC = "vault-git-auto-sync-sidebar";

const DEFAULT_SETTINGS = {
  autoSyncEnabled: false,
  branchManagementEnabled: false,
  intervalSeconds: 60,
  targetBranch: "develop",
  remote: "origin",
  commitMessage: "Vault sync",
  autoPush: true,
  includeTimestampInCommit: true,
  pullWithRebase: true,
  autoSyncOnStartup: true,
  showSuccessNotice: true,
};

class VaultGitAutoSyncPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.syncTimer = null;
    this.statusRefreshTimer = null;
    this.isSyncInProgress = false;
    this.targetBranches = [];

    this.registerEvent(
      this.app.vault.on("modify", () => this.scheduleStatusRefresh()),
    );

    this.registerEvent(
      this.app.vault.on("create", () => this.scheduleStatusRefresh()),
    );

    this.registerEvent(
      this.app.vault.on("delete", () => this.scheduleStatusRefresh()),
    );

    this.registerEvent(
      this.app.vault.on("rename", () => this.scheduleStatusRefresh()),
    );

    this.app.workspace.onLayoutReady(() => {
      this.refreshTargetBranches();
    });

    this.registerView(
      VIEW_TYPE_GIT_AUTO_SYNC,
      (leaf) => new VaultGitAutoSyncView(leaf, this),
    );

    this.addRibbonIcon("git-branch", "Open Vault Git Auto Sync", () => {
      this.openSyncPanel();
    });

    this.addCommand({
      id: "run-sync-now",
      name: "Run git sync now",
      callback: async () => {
        await this.syncVault("manual");
      },
    });

    this.addCommand({
      id: "open-sync-panel",
      name: "Open Vault Git Auto Sync panel",
      callback: () => {
        this.openSyncPanel();
      },
    });

    this.addCommand({
      id: "restart-sync-scheduler",
      name: "Restart git sync scheduler",
      callback: () => {
        if (!this.settings.autoSyncEnabled) {
          new Notice("Vault Git Auto Sync: auto sync is disabled in settings.");
          return;
        }

        this.restartScheduler();

        new Notice("Vault Git Auto Sync: scheduler restarted.");
      },
    });

    this.addCommand({
      id: "checkout-target-branch",
      name: "Checkout configured branch",
      callback: async () => {
        await this.checkoutTargetBranch();
      },
    });

    this.addSettingTab(new VaultGitAutoSyncSettingTab(this.app, this));

    if (this.settings.autoSyncEnabled) {
      this.restartScheduler();

      if (this.settings.autoSyncOnStartup) {
        this.syncVault("startup");
      }
    }
  }

  onunload() {
    this.stopScheduler();

    if (this.statusRefreshTimer) {
      window.clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = null;
    }

    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GIT_AUTO_SYNC);
  }

  scheduleStatusRefresh() {
    if (this.statusRefreshTimer) {
      window.clearTimeout(this.statusRefreshTimer);
    }

    this.statusRefreshTimer = window.setTimeout(() => {
      this.statusRefreshTimer = null;
      this.refreshOpenSyncPanels();
    }, 500);
  }

  async refreshOpenSyncPanels() {
    await Promise.all(
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_GIT_AUTO_SYNC)
        .map((leaf) => {
          if (
            leaf.view &&
            typeof leaf.view.refreshPendingChanges === "function"
          ) {
            return leaf.view.refreshPendingChanges();
          }

          return Promise.resolve();
        }),
    );
  }

  async refreshOpenSyncPanelViews() {
    await Promise.all(
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_GIT_AUTO_SYNC)
        .map((leaf) => {
          if (leaf.view && typeof leaf.view.render === "function") {
            return leaf.view.render();
          }

          return Promise.resolve();
        }),
    );
  }

  async openSyncPanel() {
    const existingLeaf = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_GIT_AUTO_SYNC,
    )[0];

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      new Notice(
        "Vault Git Auto Sync: could not open the sidebar panel.",
        7000,
      );
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_GIT_AUTO_SYNC,
      active: true,
    });

    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    if (!String(this.settings.targetBranch || "").trim()) {
      this.settings.targetBranch = DEFAULT_SETTINGS.targetBranch;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  restartScheduler() {
    this.stopScheduler();

    if (!this.settings.autoSyncEnabled) {
      return;
    }

    const intervalMs =
      Math.max(15, Number(this.settings.intervalSeconds) || 60) * 1000;

    this.syncTimer = setInterval(() => {
      this.syncVault("interval");
    }, intervalMs);
  }

  stopScheduler() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async runGit(args) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.app.vault.adapter.basePath,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail = (
              stderr ||
              stdout ||
              error.message ||
              "Unknown git error"
            ).trim();

            reject(new Error(detail));
            return;
          }

          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        },
      );
    });
  }

  async remoteBranchExists(remote, branch) {
    try {
      await this.runGit([
        "ls-remote",
        "--exit-code",
        "--heads",
        remote,
        `refs/heads/${branch}`,
      ]);

      return true;
    } catch (_error) {
      return false;
    }
  }

  async listBranches() {
    const remote = (this.settings.remote || "origin").trim();

    const branches = new Set();

    const localBranches = await this.runGit([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);

    localBranches.stdout
      .split("\n")
      .map((branch) => branch.trim())
      .filter(Boolean)
      .forEach((branch) => branches.add(branch));

    try {
      const remoteBranches = await this.runGit([
        "ls-remote",
        "--heads",
        remote,
      ]);

      remoteBranches.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((ref) => ref && ref.startsWith("refs/heads/"))
        .map((ref) => ref.replace("refs/heads/", ""))
        .forEach((branch) => branches.add(branch));
    } catch (_error) {
      // Local branches remain available when the remote
      // cannot be queried.
    }

    return Array.from(branches).sort((a, b) => a.localeCompare(b));
  }

  async refreshTargetBranches({ notify = false } = {}) {
    try {
      this.targetBranches = await this.listBranches();
      return this.targetBranches;
    } catch (error) {
      this.targetBranches = [];

      if (notify) {
        new Notice(
          `Vault Git Auto Sync: could not load branches: ${error.message}`,
          7000,
        );
      }

      console.error("Vault Git Auto Sync branch list error", error);

      return this.targetBranches;
    }
  }

  async checkoutTargetBranch(options = {}) {
    const { notify = true, restartScheduler = true } = options;

    if (!this.settings.branchManagementEnabled) {
      if (notify) {
        new Notice(
          "Vault Git Auto Sync: enable branch management mode first.",
          7000,
        );
      }

      return false;
    }

    const branch = (this.settings.targetBranch || "").trim();

    if (!branch) {
      if (notify) {
        new Notice(
          "Vault Git Auto Sync: set a target branch in settings first.",
          7000,
        );
      }

      return false;
    }

    try {
      await this.runGit(["rev-parse", "--is-inside-work-tree"]);

      const remote = (this.settings.remote || "origin").trim();

      await this.runGit(["fetch", remote]);

      let localBranchExists = true;

      try {
        await this.runGit(["show-ref", "--verify", `refs/heads/${branch}`]);
      } catch (_error) {
        localBranchExists = false;
      }

      if (localBranchExists) {
        await this.runGit(["checkout", branch]);
      } else if (await this.remoteBranchExists(remote, branch)) {
        await this.runGit([
          "checkout",
          "-b",
          branch,
          "--track",
          `${remote}/${branch}`,
        ]);
      } else {
        await this.runGit(["checkout", "-b", branch]);

        if (notify) {
          new Notice(
            `Vault Git Auto Sync: created new local branch ${branch}.`,
            6000,
          );
        }
      }

      if (restartScheduler && this.settings.autoSyncEnabled) {
        this.restartScheduler();
      }

      if (notify) {
        new Notice(`Vault Git Auto Sync: now on branch ${branch}.`, 6000);
      }

      return true;
    } catch (error) {
      if (notify) {
        new Notice(
          `Vault Git Auto Sync branch checkout error: ${error.message}`,
          10000,
        );
      }

      console.error("Vault Git Auto Sync branch checkout error", error);

      return false;
    }
  }

  async syncVault(trigger) {
    if (this.isSyncInProgress) {
      return;
    }

    this.isSyncInProgress = true;

    try {
      await this.runGit(["rev-parse", "--is-inside-work-tree"]);

      const configuredBranch = (this.settings.targetBranch || "").trim();

      const current = await this.runGit(["branch", "--show-current"]);

      if (!current.stdout) {
        throw new Error("Could not determine current branch.");
      }

      if (
        this.settings.branchManagementEnabled &&
        configuredBranch &&
        current.stdout !== configuredBranch
      ) {
        const checkedOut = await this.checkoutTargetBranch({
          notify: false,
          restartScheduler: false,
        });

        if (!checkedOut) {
          throw new Error(
            `Could not checkout configured branch "${configuredBranch}".`,
          );
        }
      }

      const checkedOutBranch = await this.runGit(["branch", "--show-current"]);

      const branch = checkedOutBranch.stdout;

      if (!branch) {
        throw new Error("Could not determine current branch.");
      }

      const remote = (this.settings.remote || "origin").trim();

      const remoteBranchAvailable = await this.remoteBranchExists(
        remote,
        branch,
      );

      if (remoteBranchAvailable) {
        await this.runGit(["fetch", remote, branch]);
      }

      let remoteCommits = 0;

      if (remoteBranchAvailable) {
        const remoteAhead = await this.runGit([
          "rev-list",
          "--count",
          `HEAD..${remote}/${branch}`,
        ]);

        remoteCommits = Number(remoteAhead.stdout || "0");
      }

      if (remoteCommits > 0) {
        if (this.settings.pullWithRebase) {
          await this.runGit([
            "pull",
            "--rebase",
            "--autostash",
            remote,
            branch,
          ]);
        } else {
          await this.runGit(["pull", remote, branch]);
        }
      }

      const status = await this.runGit(["status", "--porcelain"]);

      const hasLocalChanges = Boolean(status.stdout);

      let createdCommit = false;

      if (hasLocalChanges) {
        await this.runGit(["add", "-A"]);

        let commitMessage = this.settings.commitMessage || "Vault sync";

        if (this.settings.includeTimestampInCommit) {
          const now = new Date();
          const ts = now.toISOString().replace("T", " ").slice(0, 19);

          commitMessage = `${commitMessage} (${ts})`;
        }

        const changedFiles = await this.runGit([
          "diff",
          "--cached",
          "--name-status",
        ]);

        const commitBody = changedFiles.stdout || "(not listed)";

        await this.runGit(["commit", "-m", commitMessage, "-m", commitBody]);

        createdCommit = true;
      }

      let pushed = false;

      if (this.settings.autoPush) {
        let localCommits = 1;

        if (remoteBranchAvailable) {
          const localAhead = await this.runGit([
            "rev-list",
            "--count",
            `${remote}/${branch}..HEAD`,
          ]);

          localCommits = Number(localAhead.stdout || "0");
        }

        if (localCommits > 0) {
          await this.runGit(["push", "--set-upstream", remote, branch]);

          pushed = true;
        }
      }

      if (this.settings.showSuccessNotice) {
        const parts = [
          "Vault Git Auto Sync complete.",
          `(trigger: ${trigger})`,
          remoteCommits > 0 ? `pulled ${remoteCommits}` : "no pull",
          createdCommit ? "committed" : "no local commit",
          pushed ? "pushed" : "no push",
        ];

        new Notice(parts.join(" | "), 6000);
      }
    } catch (error) {
      new Notice(`Vault Git Auto Sync error: ${error.message}`, 10000);

      console.error("Vault Git Auto Sync error", error);
    } finally {
      await this.refreshOpenSyncPanelViews();
      this.isSyncInProgress = false;
    }
  }
}

class VaultGitAutoSyncView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_GIT_AUTO_SYNC;
  }

  getDisplayText() {
    return "Vault Git Auto Sync";
  }

  getIcon() {
    return "git-branch";
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.addClass("vault-git-auto-sync-panel");

    const loadingEl = contentEl.createDiv({
      cls: "vault-git-auto-sync-loading",
      text: "Loading Git status...",
    });

    let initialCurrentBranch = "detached HEAD";

    try {
      const current = await this.plugin.runGit(["branch", "--show-current"]);

      initialCurrentBranch = current.stdout || "detached HEAD";
    } catch (_error) {
      initialCurrentBranch = "Git status unavailable";
    }

    if (this.plugin.settings.branchManagementEnabled) {
      await this.plugin.refreshTargetBranches({
        notify: true,
      });
    }

    loadingEl.remove();

    const header = contentEl.createDiv({
      cls: "vault-git-auto-sync-header",
    });

    const title = header.createDiv({
      cls: "vault-git-auto-sync-title",
    });

    const titleIcon = title.createSpan({
      cls: "vault-git-auto-sync-title-icon",
    });

    setIcon(titleIcon, "git-branch");

    title.createEl("h2", {
      text: "Git sync",
    });

    const helpButton = this.createIconButton(
      header,
      "help-circle",
      "Open the Command Palette (Ctrl/Cmd+P)",
    );

    helpButton.addEventListener("click", () => {
      new Notice(
        "Open Command Palette with Ctrl/Cmd+P, then run 'Open Vault Git Auto Sync panel'.",
        7000,
      );
    });

    const statusCard = contentEl.createDiv({
      cls: "vault-git-auto-sync-status",
    });

    const statusEl = statusCard.createDiv({
      cls: "vault-git-auto-sync-status-line",
    });

    const targetEl = statusCard.createDiv({
      cls: "vault-git-auto-sync-status-line",
    });

    const changesSection = contentEl.createDiv({
      cls: "vault-git-auto-sync-section",
    });

    const changesHeader = changesSection.createDiv({
      cls: "vault-git-auto-sync-section-header",
    });

    changesHeader.createEl("div", {
      text: "Pending changes",
      cls: "vault-git-auto-sync-section-title",
    });

    const changesCountEl = changesHeader.createDiv({
      cls: "vault-git-auto-sync-changes-count",
    });

    const changesListEl = changesSection.createEl("ul", {
      cls: "vault-git-auto-sync-changes-list",
    });

    this.changesCountEl = changesCountEl;
    this.changesListEl = changesListEl;

    const refreshChangesButton = this.createIconButton(
      changesHeader,
      "refresh-cw",
      "Refresh pending changes",
    );

    refreshChangesButton.addEventListener("click", async () => {
      refreshChangesButton.disabled = true;

      await this.refreshChanges(changesCountEl, changesListEl);

      refreshChangesButton.disabled = false;
    });

    await this.refreshChanges(changesCountEl, changesListEl);

    const autoSyncRow = contentEl.createDiv({
      cls: "vault-git-auto-sync-toggle-row",
    });

    const autoSyncToggle = autoSyncRow.createEl("input", {
      type: "checkbox",
      attr: {
        id: "vault-git-auto-sync-enabled",
      },
      cls: "vault-git-auto-sync-enabled",
    });

    autoSyncToggle.checked = this.plugin.settings.autoSyncEnabled;

    const autoSyncLabel = autoSyncRow.createEl("label", {
      text: this.plugin.settings.autoSyncEnabled
        ? "Auto sync enabled"
        : "Auto sync disabled",
      attr: {
        for: "vault-git-auto-sync-enabled",
      },
    });

    autoSyncToggle.addEventListener("change", async () => {
      this.plugin.settings.autoSyncEnabled = autoSyncToggle.checked;

      await this.plugin.saveSettings();

      if (autoSyncToggle.checked) {
        this.plugin.restartScheduler();
        autoSyncLabel.setText("Auto sync enabled");
      } else {
        this.plugin.stopScheduler();
        autoSyncLabel.setText("Auto sync disabled");
      }
    });

    if (this.plugin.settings.branchManagementEnabled) {
      const branchSection = contentEl.createDiv({
        cls: "vault-git-auto-sync-section",
      });

      branchSection.createEl("div", {
        text: "Target branch",
        cls: "vault-git-auto-sync-section-title",
      });

      const branchRow = branchSection.createDiv({
        cls: "vault-git-auto-sync-row",
      });

      const branchSelect = branchRow.createEl("select", {
        cls: "vault-git-auto-sync-branch-select",
      });

      const populateBranches = async (notify = false, refresh = true) => {
        const branches = refresh
          ? await this.plugin.refreshTargetBranches({
              notify,
            })
          : this.plugin.targetBranches;

        const selectedBranch = this.plugin.settings.targetBranch || "develop";

        branchSelect.empty();

        branches.forEach((branch) => {
          branchSelect.createEl("option", {
            text: branch,
            value: branch,
          });
        });

        if (!branches.includes(selectedBranch)) {
          branchSelect.createEl("option", {
            text: `${selectedBranch} (new)`,
            value: selectedBranch,
          });
        }

        branchSelect.value = selectedBranch;
      };

      branchSelect.addEventListener("change", async () => {
        this.plugin.settings.targetBranch = branchSelect.value;

        await this.plugin.saveSettings();

        targetEl.setText(`Target branch: ${branchSelect.value}`);
      });

      const branchRefreshButton = this.createIconButton(
        branchRow,
        "refresh-cw",
        "Refresh branches",
      );

      branchRefreshButton.addEventListener("click", async () => {
        branchRefreshButton.disabled = true;

        await populateBranches(true);

        branchRefreshButton.disabled = false;
      });

      await populateBranches(false, false);

      const newBranchRow = branchSection.createDiv({
        cls: "vault-git-auto-sync-row",
      });

      const newBranchInput = newBranchRow.createEl("input", {
        type: "text",
        placeholder: "feature/my-branch",
      });

      const createBranchButton = this.createIconButton(
        newBranchRow,
        "plus",
        "Create and checkout new branch",
      );

      createBranchButton.addEventListener("click", async () => {
        const branch = newBranchInput.value.trim();

        if (!branch) {
          new Notice("Vault Git Auto Sync: enter a branch name first.", 6000);
          return;
        }

        createBranchButton.disabled = true;

        this.plugin.settings.targetBranch = branch;

        await this.plugin.saveSettings();

        const checkedOut = await this.plugin.checkoutTargetBranch();

        if (checkedOut) {
          await populateBranches();

          targetEl.setText(`Target branch: ${branch}`);

          branchSelect.value = branch;
          newBranchInput.value = "";
        }

        createBranchButton.disabled = false;

        await this.refreshStatus(statusEl, targetEl);
      });
    }

    const actions = contentEl.createDiv({
      cls: "vault-git-auto-sync-actions",
    });

    let checkoutButton;

    if (this.plugin.settings.branchManagementEnabled) {
      const secondaryActions = actions.createDiv({
        cls: "vault-git-auto-sync-secondary-actions",
      });

      checkoutButton = this.createIconButton(
        secondaryActions,
        "check",
        "Checkout selected branch",
      );

      const refreshButton = this.createIconButton(
        secondaryActions,
        "refresh-cw",
        "Refresh Git status",
      );

      refreshButton.addEventListener("click", async () => {
        refreshButton.disabled = true;

        await this.plugin.refreshTargetBranches({
          notify: true,
        });

        await this.refreshStatus(statusEl, targetEl);

        refreshButton.disabled = false;
      });

      const actionsDivider = actions.createDiv({
        cls: "vault-git-auto-sync-actions-divider",
      });

      actionsDivider.setAttribute("role", "separator");
    }

    const syncButton = this.createIconButton(
      actions,
      "arrow-up-down",
      "Sync now",
      "mod-cta",
    );

    syncButton.addEventListener("click", async () => {
      syncButton.disabled = true;
      syncButton.setAttribute("aria-label", "Syncing...");

      setIcon(syncButton, "loader");

      await this.plugin.syncVault("sidebar-button");

      syncButton.disabled = false;
      syncButton.setAttribute("aria-label", "Sync now");

      setIcon(syncButton, "arrow-up-down");

      await this.refreshStatus(statusEl, targetEl);

      await this.refreshChanges(changesCountEl, changesListEl);
    });

    if (checkoutButton) {
      checkoutButton.addEventListener("click", async () => {
        checkoutButton.disabled = true;

        await this.plugin.checkoutTargetBranch();

        checkoutButton.disabled = false;

        await this.refreshStatus(statusEl, targetEl);

        await this.refreshChanges(changesCountEl, changesListEl);
      });
    }

    statusEl.setText(`Current branch: ${initialCurrentBranch}`);

    targetEl.setText(
      `Target branch: ${this.plugin.settings.targetBranch || "not set"}`,
    );
  }

  createIconButton(parent, icon, label, ...classes) {
    const button = parent.createEl("button", {
      cls: ["clickable-icon", "vault-git-auto-sync-icon-button", ...classes],
      attr: {
        "aria-label": label,
        "data-tooltip-position": "top",
      },
    });

    setIcon(button, icon);

    return button;
  }

  async refreshStatus(statusEl, targetEl) {
    targetEl.setText(
      `Target branch: ${this.plugin.settings.targetBranch || "not set"}`,
    );

    try {
      const current = await this.plugin.runGit(["branch", "--show-current"]);

      statusEl.setText(`Current branch: ${current.stdout || "detached HEAD"}`);
    } catch (error) {
      statusEl.setText(`Git status unavailable: ${error.message}`);
    }
  }

  async refreshChanges(changesCountEl, changesListEl) {
    try {
      const result = await this.plugin.runGit(["status", "--short"]);

      const changes = result.stdout
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);

      changesCountEl.setText(
        changes.length === 0
          ? "Clean"
          : `${changes.length} change${changes.length === 1 ? "" : "s"}`,
      );

      changesListEl.empty();

      if (changes.length === 0) {
        changesListEl.createEl("li", {
          text: "No local changes to commit.",
          cls: "vault-git-auto-sync-no-changes",
        });

        return;
      }

      changes.forEach((change) => {
        const code = change.slice(0, 2).trim() || "??";
        const file = change.slice(2).trim() || change;

        const item = changesListEl.createEl("li");

        item.createEl("span", {
          text: code,
          cls: "vault-git-auto-sync-change-status",
        });

        item.createEl("span", {
          text: file,
        });
      });
    } catch (error) {
      changesCountEl.setText("Unavailable");
      changesListEl.empty();

      changesListEl.createEl("li", {
        text: error.message,
      });
    }
  }

  async refreshPendingChanges() {
    if (!this.changesCountEl || !this.changesListEl) {
      return;
    }

    await this.refreshChanges(this.changesCountEl, this.changesListEl);
  }
}

class VaultGitAutoSyncSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", {
      text: "Vault Git Auto Sync",
    });

    new Setting(containerEl)
      .setName("Enable auto sync")
      .setDesc("Enable periodic sync using the configured interval.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncEnabled = value;

            await this.plugin.saveSettings();

            if (value) {
              this.plugin.restartScheduler();
            } else {
              this.plugin.stopScheduler();
            }

            await this.plugin.refreshOpenSyncPanelViews();
          }),
      );

    new Setting(containerEl)
      .setName("Enable branch management mode")
      .setDesc(
        "Allow branch selection, creation, checkout, and automatic checkout during sync.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.branchManagementEnabled)
          .onChange(async (value) => {
            this.plugin.settings.branchManagementEnabled = value;

            await this.plugin.saveSettings();

            await this.plugin.refreshOpenSyncPanelViews();
          }),
      );

    new Setting(containerEl)
      .setName("Interval (seconds)")
      .setDesc("How often to run sync automatically.")
      .addText((text) =>
        text
          .setPlaceholder("60")
          .setValue(String(this.plugin.settings.intervalSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);

            this.plugin.settings.intervalSeconds =
              Number.isFinite(parsed) && parsed > 0 ? parsed : 60;

            await this.plugin.saveSettings();

            if (this.plugin.settings.autoSyncEnabled) {
              this.plugin.restartScheduler();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Remote")
      .setDesc("Git remote name.")
      .addText((text) =>
        text.setValue(this.plugin.settings.remote).onChange(async (value) => {
          this.plugin.settings.remote = value.trim() || "origin";

          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Commit message")
      .setDesc("Message used when local changes are committed.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.commitMessage)
          .onChange(async (value) => {
            this.plugin.settings.commitMessage = value || "Vault sync";

            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto push")
      .setDesc("Push local commits after syncing.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoPush)
          .onChange(async (value) => {
            this.plugin.settings.autoPush = value;

            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Include timestamp in commit")
      .setDesc("Append ISO timestamp to commit messages.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.includeTimestampInCommit)
          .onChange(async (value) => {
            this.plugin.settings.includeTimestampInCommit = value;

            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Pull with rebase")
      .setDesc("Use pull --rebase --autostash when remote has changes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.pullWithRebase)
          .onChange(async (value) => {
            this.plugin.settings.pullWithRebase = value;

            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto sync on startup")
      .setDesc("Start scheduler and run one sync when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnStartup = value;

            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show success notices")
      .setDesc("Show a desktop notice for successful sync cycles.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSuccessNotice)
          .onChange(async (value) => {
            this.plugin.settings.showSuccessNotice = value;

            await this.plugin.saveSettings();
          }),
      );
  }
}

module.exports = VaultGitAutoSyncPlugin;
