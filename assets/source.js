(() => {
  const copy = async (value) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  };

  document.querySelectorAll('[data-source-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const original = button.textContent;
      try {
        await copy(button.dataset.sourceCopy || '');
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      window.setTimeout(() => { button.textContent = original; }, 1800);
    });
  });

  document.querySelectorAll('[data-source-branch-select]').forEach((select) => {
    select.addEventListener('change', () => {
      if (select.value) window.location.href = `${select.dataset.sourceBranchBase}${encodeURIComponent(select.value)}`;
    });
  });

  document.querySelectorAll('[data-source-repo-tabs]').forEach((tabs) => {
    const buttons = tabs.querySelectorAll('[data-source-repo-tab]');
    const panels = tabs.querySelectorAll('[data-source-repo-panel]');
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const selected = button.dataset.sourceRepoTab;
        buttons.forEach((item) => item.setAttribute('aria-selected', String(item === button)));
        panels.forEach((panel) => { panel.hidden = panel.dataset.sourceRepoPanel !== selected; });
      });
    });
  });
})();
