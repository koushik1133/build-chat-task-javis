import type { NextRequest } from "next/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ siteId: string }> }
) {
  const { siteId } = await params;
  
  // The app url where this is hosted
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const apiUrl = `${baseUrl}/api/leads/widget/${siteId}`;

  const jsCode = `
(function() {
  if (document.getElementById('kh-widget-container')) return;

  var container = document.createElement('div');
  container.id = 'kh-widget-container';
  container.style.position = 'fixed';
  container.style.bottom = '20px';
  container.style.right = '20px';
  container.style.zIndex = '999999';
  container.style.fontFamily = 'system-ui, -apple-system, sans-serif';

  var button = document.createElement('button');
  button.innerHTML = '💬 Chat with us';
  button.style.backgroundColor = '#f97316';
  button.style.color = '#fff';
  button.style.border = 'none';
  button.style.borderRadius = '9999px';
  button.style.padding = '12px 24px';
  button.style.fontSize = '16px';
  button.style.fontWeight = '600';
  button.style.cursor = 'pointer';
  button.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
  button.style.transition = 'transform 0.2s, box-shadow 0.2s';
  button.onmouseover = function() { button.style.transform = 'translateY(-2px)'; button.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'; };
  button.onmouseout = function() { button.style.transform = 'translateY(0)'; button.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'; };

  var modal = document.createElement('div');
  modal.style.display = 'none';
  modal.style.position = 'absolute';
  modal.style.bottom = '70px';
  modal.style.right = '0';
  modal.style.width = '320px';
  modal.style.backgroundColor = '#fff';
  modal.style.borderRadius = '12px';
  modal.style.boxShadow = '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)';
  modal.style.overflow = 'hidden';
  modal.style.border = '1px solid #e5e7eb';

  var header = document.createElement('div');
  header.style.backgroundColor = '#f97316';
  header.style.color = '#fff';
  header.style.padding = '16px';
  header.style.fontWeight = '600';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.innerHTML = '<span>Contact Us</span>';

  var closeBtn = document.createElement('button');
  closeBtn.innerHTML = '×';
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.color = '#fff';
  closeBtn.style.fontSize = '24px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.lineHeight = '1';
  closeBtn.onclick = function() { modal.style.display = 'none'; };
  header.appendChild(closeBtn);

  var form = document.createElement('form');
  form.style.padding = '16px';
  form.style.display = 'flex';
  form.style.flexDirection = 'column';
  form.style.gap = '12px';

  function createInput(name, placeholder, type) {
    var input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type || 'text';
    input.name = name;
    input.placeholder = placeholder;
    input.required = true;
    input.style.width = '100%';
    input.style.padding = '8px 12px';
    input.style.border = '1px solid #d1d5db';
    input.style.borderRadius = '6px';
    input.style.fontSize = '14px';
    input.style.boxSizing = 'border-box';
    if (type === 'textarea') {
      input.style.resize = 'vertical';
      input.style.minHeight = '80px';
    }
    return input;
  }

  var nameInput = createInput('name', 'Your Name');
  var emailInput = createInput('email', 'Email Address', 'email');
  var companyInput = createInput('company', 'Company (Optional)');
  companyInput.required = false;
  var messageInput = createInput('message', 'How can we help?', 'textarea');

  var submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.innerHTML = 'Send Message';
  submitBtn.style.backgroundColor = '#000';
  submitBtn.style.color = '#fff';
  submitBtn.style.border = 'none';
  submitBtn.style.borderRadius = '6px';
  submitBtn.style.padding = '10px';
  submitBtn.style.fontWeight = '500';
  submitBtn.style.cursor = 'pointer';
  submitBtn.style.marginTop = '4px';

  form.appendChild(nameInput);
  form.appendChild(emailInput);
  form.appendChild(companyInput);
  form.appendChild(messageInput);
  form.appendChild(submitBtn);

  var successMsg = document.createElement('div');
  successMsg.style.display = 'none';
  successMsg.style.padding = '32px 16px';
  successMsg.style.textAlign = 'center';
  successMsg.style.color = '#10b981';
  successMsg.style.fontWeight = '500';
  successMsg.innerHTML = 'Thanks! We\\'ll be in touch soon.';

  modal.appendChild(header);
  modal.appendChild(form);
  modal.appendChild(successMsg);

  button.onclick = function() {
    modal.style.display = modal.style.display === 'none' ? 'block' : 'none';
  };

  form.onsubmit = function(e) {
    e.preventDefault();
    submitBtn.innerHTML = 'Sending...';
    submitBtn.disabled = true;

    var data = {
      name: nameInput.value,
      email: emailInput.value,
      company: companyInput.value,
      message: messageInput.value,
      source: 'Widget'
    };

    fetch('${apiUrl}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    .then(function(res) { return res.json(); })
    .then(function(res) {
      form.style.display = 'none';
      successMsg.style.display = 'block';
      setTimeout(function() {
        modal.style.display = 'none';
        form.reset();
        form.style.display = 'flex';
        successMsg.style.display = 'none';
        submitBtn.innerHTML = 'Send Message';
        submitBtn.disabled = false;
      }, 4000);
    })
    .catch(function(err) {
      console.error('Widget error:', err);
      submitBtn.innerHTML = 'Error. Try again.';
      submitBtn.disabled = false;
    });
  };

  container.appendChild(modal);
  container.appendChild(button);
  document.body.appendChild(container);
})();
`;

  return new Response(jsCode, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
