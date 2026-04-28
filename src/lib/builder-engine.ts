export const BUILDER_ENGINE_SCRIPT = `
<script id="jarvis-builder-engine">
(function() {
  window.addEventListener('DOMContentLoaded', () => {
    initBuilder();
  });

  // Also re-init if DOM changes (e.g., inline edit mode or drops)
  let domTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(domTimer);
    domTimer = setTimeout(initBuilder, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let draggedEl = null;
  let isInternalDrag = false;

  function initBuilder() {
    const draggables = document.querySelectorAll('section, header, footer, [data-jarvis-item="true"]');
    
    draggables.forEach(el => {
      // Avoid attaching multiple times
      if (el.getAttribute('data-jarvis-dnd')) return;
      el.setAttribute('data-jarvis-dnd', 'true');
      el.setAttribute('draggable', 'true');
      
      // Apply subtle grab cursor if not already set
      if (!el.style.cursor) el.style.cursor = 'grab';
      
      el.addEventListener('dragstart', (e) => {
        if (el.getAttribute('contenteditable') === 'true') {
          e.preventDefault();
          return;
        }
        draggedEl = el;
        isInternalDrag = true;
        e.dataTransfer.effectAllowed = 'move';
        el.style.opacity = '0.4';
        
        // Prevent event bubbling if dragging a sub-item
        e.stopPropagation();
      });

      el.addEventListener('dragend', () => {
        el.style.opacity = '1';
        el.style.borderTop = '';
        el.style.borderBottom = '';
        draggedEl = null;
        isInternalDrag = false;
        syncHtml();
      });

      el.addEventListener('dragover', (e) => {
        e.preventDefault(); // allow drop
        e.dataTransfer.dropEffect = 'move';
        e.stopPropagation();
        
        const isSection = el.tagName === 'SECTION' || el.tagName === 'HEADER' || el.tagName === 'FOOTER';
        
        // Only allow dropping sections on sections, or items on items within the same parent
        if (draggedEl) {
          const draggedIsSection = draggedEl.tagName === 'SECTION' || draggedEl.tagName === 'HEADER' || draggedEl.tagName === 'FOOTER';
          if (draggedIsSection !== isSection) return;
          if (!draggedIsSection && draggedEl.parentElement !== el.parentElement) return;
        }

        const bounding = el.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        
        // Remove previous borders
        document.querySelectorAll('[data-jarvis-dnd]').forEach(target => {
          target.style.borderTop = '';
          target.style.borderBottom = '';
        });

        if (e.clientY - offset > 0) {
          el.style.borderBottom = '4px solid #6366f1'; // indigo-500
        } else {
          el.style.borderTop = '4px solid #6366f1';
        }
      });

      el.addEventListener('dragleave', () => {
        el.style.borderTop = '';
        el.style.borderBottom = '';
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.style.borderTop = '';
        el.style.borderBottom = '';
        
        const bounding = el.getBoundingClientRect();
        const offset = bounding.y + (bounding.height / 2);
        const insertAfter = e.clientY - offset > 0;

        // Internal reordering
        if (isInternalDrag && draggedEl && draggedEl !== el) {
          // Check if same type and (if items) same parent
          const isSection = el.tagName === 'SECTION' || el.tagName === 'HEADER' || el.tagName === 'FOOTER';
          const draggedIsSection = draggedEl.tagName === 'SECTION' || draggedEl.tagName === 'HEADER' || draggedEl.tagName === 'FOOTER';
          
          if (isSection === draggedIsSection) {
            if (isSection || draggedEl.parentElement === el.parentElement) {
              if (insertAfter) {
                el.insertAdjacentElement('afterend', draggedEl);
              } else {
                el.insertAdjacentElement('beforebegin', draggedEl);
              }
            }
          }
        } 
        // Drop from parent sidebar (only for sections)
        else if (!isInternalDrag) {
          const componentType = e.dataTransfer.getData('javis-component');
          const isSection = el.tagName === 'SECTION' || el.tagName === 'HEADER' || el.tagName === 'FOOTER';
          
          if (componentType && isSection) {
            const id = 'placeholder-' + Date.now();
            const placeholder = document.createElement('section');
            placeholder.id = id;
            placeholder.innerHTML = '<div style="padding:60px 20px;text-align:center;background:var(--surface);border:2px dashed var(--border);border-radius:var(--radius);margin:20px;font-family:sans-serif;color:var(--text);font-weight:500;">✨ Generating ' + componentType + ' component...</div>';
            
            if (insertAfter) {
              el.insertAdjacentElement('afterend', placeholder);
            } else {
              el.insertAdjacentElement('beforebegin', placeholder);
            }
            
            window.parent.postMessage({ type: 'jarvis:generate-component', componentType, placeholderId: id }, '*');
          }
        }
      });
    });
  }

  // Listen for component generated by parent
  window.addEventListener('message', (e) => {
    if (e.data.type === 'jarvis:replace-placeholder') {
      const placeholder = document.getElementById(e.data.placeholderId);
      if (placeholder) {
        // Create a temporary container to parse the new HTML
        const temp = document.createElement('div');
        temp.innerHTML = e.data.html.trim();
        const newSection = temp.firstElementChild;
        if (newSection) {
          placeholder.replaceWith(newSection);
          initBuilder(); // re-init to make the new section draggable
          syncHtml();
        } else {
          placeholder.remove();
        }
      }
    }
  });

  function syncHtml() {
    // Clone body to strip out injected attributes/scripts before saving
    const clone = document.documentElement.cloneNode(true);
    
    // Remove all Jarvis scripts and elements
    ['#jarvis-builder-engine', '#jarvis-edit-script', '#jarvis-edit-style', '#jarvis-edit-toast'].forEach(selector => {
      const el = clone.querySelector(selector);
      if (el) el.remove();
    });
    
    clone.querySelectorAll('[data-jarvis-dnd]').forEach(el => {
      el.removeAttribute('data-jarvis-dnd');
      el.removeAttribute('draggable');
      el.style.cursor = '';
      el.style.opacity = '';
      el.style.borderTop = '';
      el.style.borderBottom = '';
      if (el.getAttribute('style') === '') el.removeAttribute('style');
    });

    clone.querySelectorAll('[data-jarvis-editable]').forEach(el => {
      el.removeAttribute('data-jarvis-editable');
      el.removeAttribute('contenteditable');
    });

    const cleanHtml = "<!doctype html>\\n" + clone.outerHTML;
    window.parent.postMessage({ type: 'jarvis:save', html: cleanHtml }, '*');
  }
})();
</script>
`;
