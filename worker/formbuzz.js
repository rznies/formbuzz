(function() {
  "use strict";
  if (typeof document === 'undefined') return;
  const VERSION = "1.4.0";
  
  const currentScript = document.currentScript;
  if (!currentScript) return;
  const apiKey = currentScript.getAttribute("data-api-key");
  if (!apiKey) return;

  // Resolve endpoint dynamically from the script src
  let apiOrigin = "https://api.formbuzz.com";
  try {
    const url = new URL(currentScript.src);
    apiOrigin = url.origin;
  } catch (e) {
    // Fallback if URL parsing fails
  }
  const API_ENDPOINT = `${apiOrigin}/v1/submit/${apiKey}`;

  function cleanLabel(text) {
    if (!text) return "";
    return text.trim().replace(/[:*\s]+$/, "").trim();
  }

  function injectHoneypots(form) {
    if (form._fbHoneypots) return;
    form._fbHoneypots = {};
    
    ["formbuzz_hp", "formbeep_hp", "w2p_hp"].forEach(name => {
      const input = document.createElement("input");
      input.type = "text";
      input.name = name;
      input.id = name;
      input.value = "";
      input.autocomplete = "off";
      input.tabIndex = -1;
      input.setAttribute("aria-hidden", "true");
      input.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      
      if (form.parentNode) {
        form.parentNode.insertBefore(input, form);
        form._fbHoneypots[name] = input;
      }
    });
  }

  function resolveFieldLabel(field) {
    // 1. Explicit label with for="id"
    if (field.id) {
      const explicitLabel = document.querySelector(`label[for="${field.id}"]`);
      if (explicitLabel && explicitLabel.textContent) {
        const text = cleanLabel(explicitLabel.textContent);
        if (text) return text;
      }
    }

    // 2. Parent label element
    let parent = field.parentElement;
    while (parent) {
      if (parent.tagName === "LABEL") {
        let labelText = "";
        for (let i = 0; i < parent.childNodes.length; i++) {
          const node = parent.childNodes[i];
          // Collect text nodes or non-input elements text
          if (node.nodeType === 3 || (node.nodeType === 1 && node !== field && !/INPUT|SELECT|TEXTAREA/i.test(node.tagName))) {
            labelText += node.textContent;
          }
        }
        const text = cleanLabel(labelText);
        if (text) return text;
      }
      parent = parent.parentElement;
    }

    // 3. Previous sibling label element or label-like element
    if (field.name) {
      const sibling = field.previousElementSibling;
      if (sibling && (/label/i.test(sibling.tagName) || /label|field-label|form-label/i.test(sibling.className))) {
        const text = cleanLabel(sibling.textContent);
        if (text) return text;
      }
    }

    // 4. aria-label attribute
    const ariaLabel = field.getAttribute("aria-label");
    if (ariaLabel) {
      const text = cleanLabel(ariaLabel);
      if (text) return text;
    }

    // 5. placeholder attribute
    if (field.placeholder) {
      const text = cleanLabel(field.placeholder);
      if (text) return text;
    }

    // 6. Fallback to name
    return field.name || "";
  }

  function serializeForm(form) {
    const data = {};
    const elements = form.elements;

    for (let i = 0; i < elements.length; i++) {
      const field = elements[i];
      if (!field.name || field.disabled || field.hasAttribute("data-formbeep-ignore") || field.hasAttribute("data-formbuzz-ignore")) continue;
      if (/submit|button|reset|image|hidden/i.test(field.type)) continue;

      const label = resolveFieldLabel(field);
      if (!label) continue;

      if (field.type === "file") {
        if (field.files && field.files.length > 0) {
          const fileNames = [];
          for (let j = 0; j < field.files.length; j++) {
            fileNames.push(field.files[j].name);
          }
          data[label] = fileNames.join(", ");
        }
        continue;
      }

      if ((field.type === "checkbox" || field.type === "radio") && !field.checked) {
        continue;
      }

      if (field.type === "select-multiple") {
        const selected = [];
        for (let j = 0; j < field.options.length; j++) {
          if (field.options[j].selected) {
            selected.push(field.options[j].value || field.options[j].text);
          }
        }
        if (selected.length) {
          data[label] = selected.join(", ");
        }
        continue;
      }

      // Handle multi-value fields (e.g. multiple checkboxes with same label)
      if (data[label] !== undefined) {
        data[label] = data[label] + ", " + field.value;
      } else {
        data[label] = field.value;
      }
    }
    return data;
  }

  function enhanceForm(form) {
    if (form._fbEnhanced || form.hasAttribute("data-formbeep-ignore") || form.hasAttribute("data-formbuzz-ignore")) return;
    form._fbEnhanced = true;
    
    injectHoneypots(form);
    
    form.addEventListener("submit", function() {
      const payload = serializeForm(form);
      
      if (form._fbHoneypots) {
        Object.keys(form._fbHoneypots).forEach(name => {
          payload[name] = form._fbHoneypots[name].value;
        });
      }

      fetch(API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(err => {
        console.error("[FormBuzz] Background dispatch error:", err);
      });
    }, false);
  }

  function init() {
    const forms = document.querySelectorAll("form");
    forms.forEach(enhanceForm);

    if (window.MutationObserver) {
      const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === 1) {
              if (node.tagName === "FORM") {
                enhanceForm(node);
              } else if (node.querySelectorAll) {
                node.querySelectorAll("form").forEach(enhanceForm);
              }
            }
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose internals for unit testing
  if (typeof globalThis !== 'undefined') {
    globalThis.__FORMBUZZ_TEST__ = {
      cleanLabel,
      resolveFieldLabel,
      serializeForm,
      VERSION
    };
  }
})();
