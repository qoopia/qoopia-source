/* Persistent owner chat. Page navigation never owns its DOM or polling lifecycle. */
window.QoopiaChat = function ({api, esc, humanSize, onUnauthorized}) {
  const panel=document.querySelector('#chatPanel'),body=document.querySelector('#chatBody'),launcher=document.querySelector('#chatLauncher');
  const $=selector=>panel.querySelector(selector);
  let disposed=false,mounted=false,refresh=async()=>{},returnFocus=launcher;
  function close(){panel.hidden=true;launcher.setAttribute('aria-expanded','false');if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});}
  function open(){if(disposed)return;returnFocus=document.activeElement;panel.hidden=false;launcher.setAttribute('aria-expanded','true');if(!mounted){mounted=true;mount(body);}else void refresh();$('#chatTitle').focus({preventScroll:true});}
  launcher.hidden=false;launcher.onclick=()=>panel.hidden?open():close();
  $('#chatClose').onclick=close;
  $('#chatExpand').onclick=()=>{const expanded=panel.classList.toggle('expanded');$('#chatExpand').setAttribute('aria-pressed',String(expanded));};
  const onKey=e=>{if(e.key==='Escape'&&!panel.hidden&&panel.contains(document.activeElement)){e.preventDefault();close();}};
  const onVisible=()=>{if(!document.hidden&&!panel.hidden)void refresh();};
  document.addEventListener('keydown',onKey);document.addEventListener('visibilitychange',onVisible);
  const timer=setInterval(onVisible,1500);
  // My Qoopia agent — one persistent conversation across dashboard and Telegram.
  function mount(host) {
    host.innerHTML='<section class="my-agent work" id="myAgent"><p id="agentFeedback" role="status" aria-live="polite"></p><div id="agentSetup"></div><div id="agentWorkspace" hidden><div class="agent-toolbar"><label class="sr-only" for="agentConversation">'+esc(QI.msg('Conversation'))+'</label><select id="agentConversation"></select><button id="agentOlderConversations" hidden>'+esc(QI.msg('Older conversations'))+'</button><button id="agentNew">'+esc(QI.msg('New conversation'))+'</button></div><button id="agentOlderMessages" hidden>'+esc(QI.msg('Earlier messages'))+'</button><div id="agentMessages" class="agent-messages" role="log" aria-label="'+esc(QI.msg('Conversation'))+'" aria-live="off"></div><div id="agentFiles"></div><p id="agentProgress" role="status"></p><div id="agentRecovery" class="work-actions"></div><div id="agentApprovals"></div><form id="agentCompose"><label for="agentText">'+esc(QI.msg('Message your agent'))+'</label><textarea id="agentText" rows="2" maxlength="16000" required></textarea><div class="work-actions"><button type="button" id="agentStop" hidden>'+esc(QI.msg('Stop'))+'</button><button class="primary" id="agentSend">'+esc(QI.msg('Send'))+'</button></div></form></div><details id="agentChannel" hidden><summary>'+esc(QI.msg('Where to talk'))+'</summary><p>'+esc(QI.msg('Use this chat or connect your own Telegram bot. Qoopia must stay running on your computer.'))+'</p><div class="work-actions"><button id="agentUseDashboard">'+esc(QI.msg('Use dashboard chat'))+'</button><button id="agentUseTelegram">'+esc(QI.msg('Use Telegram'))+'</button></div><div id="telegramConnected"></div><form id="telegramForm"><p><a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">'+esc(QI.msg('Create a bot with BotFather'))+'</a>. '+esc(QI.msg('Send /newbot, choose a name, then paste its token below. Use a bot that is not connected to another application.'))+'</p><label for="telegramToken">'+esc(QI.msg('Bot token'))+'</label><input id="telegramToken" type="password" autocomplete="off" spellcheck="false" required><div class="work-actions"><button type="submit">'+esc(QI.msg('Connect Telegram'))+'</button></div></form><div id="telegramLink"></div><div id="telegramConfirm"></div></details></section>';
    const catalogs=new Map(),catalogRequests=new Set(),catalogErrors=new Map();
    const root=$('#myAgent');let actionRevision=0,lastOperation=null;let data,selected=null,busy=false,requestId=crypto.randomUUID(),lastMessages='',lastApprovals='',lastSetup='',lastOptions='',lastFiles='',olderRuns=[],allConversations=[],conversationOffset=0;
    const here=()=>!disposed&&root.isConnected,feedback=text=>{if(here())$('#agentFeedback').textContent=text;};
    async function action(body){
      const priority=body.action==='stop';
      if(busy&&!priority)throw Error(QI.msg('Please wait for the current action'));
      if(!priority)busy=true;const revision=++actionRevision;root.setAttribute('aria-busy','true');feedback(QI.msg('Working…'));$('#agentSend').disabled=true;
      try{
        const response=await fetch('/api/dashboard/my-agent',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(35000),headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify(body)});
        const result=await response.json();if(response.status===401)onUnauthorized();if(!response.ok)throw Error(QI.resolve(result.error_description||'Agent action failed'));
        if(revision===actionRevision)feedback(result.accepted?QI.msg('Preparing your agent. You can use other pages while it starts.'):QI.msg('Saved.'));return result;
      }catch(error){
        if(error.name==='TimeoutError'||error.name==='AbortError')throw Error(QI.msg('The server has not confirmed this action yet. Check its status before trying again.'));
        throw error;
      }finally{if(!priority)busy=false;if(here()&&!busy)root.removeAttribute('aria-busy');}
    }
    async function perform(body){try{const result=await action(body);await load();return result;}catch(e){feedback(e.message);}}
    async function fetchModels(provider){
      if(catalogRequests.has(provider)||!here())return;catalogRequests.add(provider);
      try {
        const response=await fetch('/api/dashboard/my-agent',{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-qoopia-csrf':'1'},body:JSON.stringify({action:'models'})});
        if(response.status===401){onUnauthorized();return;}
        const result=await response.json();if(!response.ok)throw Error(result.error_description||QI.msg('Could not load models. Try again.'));
        if(!here()||data?.provider!==provider)return;
        catalogs.set(provider,result.models);catalogErrors.delete(provider);lastSetup='';
      }catch{catalogErrors.set(provider,true);feedback(QI.msg('Could not load models. Try again.'));}
      finally{catalogRequests.delete(provider);if(here())void load();}
    }
    async function load(){
      if(!here()||busy||root.dataset.loading)return;root.dataset.loading='true';const revision=actionRevision;
      try{
        const next=await api('/api/dashboard/my-agent');if(!here()||busy||revision!==actionRevision)return;data=next;
        if(data.account&&!catalogs.has(data.provider)&&!catalogRequests.has(data.provider)&&!catalogErrors.has(data.provider))void fetchModels(data.provider);
        const preparing=data.operation?.state==='running';
        const operationKey=JSON.stringify(data.operation);if(operationKey!==lastOperation){lastOperation=operationKey;
        if(preparing)feedback(QI.msg('Preparing your agent. You can use other pages while it starts.'));
        else if(data.operation?.state==='failed')feedback(QI.msg(data.operation.error));
        else if(data.operation?.state==='completed')feedback(QI.msg('Saved.'));}
        if(selected!==data.selected){olderRuns=[];lastMessages='';}
        selected=data.selected??null;
        $('#agentChannel').hidden=!data.configured;
        $('#agentWorkspace').hidden=!data.configured;
        const setup=$('#agentSetup');
        let setupHtml='';
        if(!data.configured){
          setupHtml=data.steward&&!(data.adoptable_providers||[]).length&&!data.can_adopt?'<h2>'+esc(data.steward.name)+'</h2><p>'+esc(QI.msg('Your steward is already assigned. Continue in its application; its notes and conversations are here.'))+'</p><a href="#agents">'+esc(QI.msg('View agents and notes'))+'</a>':'<h2>'+esc(QI.msg((data.adoptable_providers||[]).length||data.can_adopt?'Continue with your Qoopia agent':'Your first agent, right here'))+'</h2><p>'+esc(QI.msg(data.can_adopt?'Keep your steward and its memory. Choose the subscription for this chat; reconnect additional tools here as needed.':'Choose ChatGPT or Claude, sign in, then give your agent a task. It can use your Qoopia memory and work in its own folder. Additional access requires your approval.'))+'</p><form id="agentSetupForm"><label for="agentFirstProvider">'+esc(QI.msg('Which subscription would you like to use?'))+'</label><select id="agentFirstProvider">'+['codex','claude_code'].filter(p=>!data.steward||(data.adoptable_providers||['codex']).includes(p)).map(p=>'<option value="'+p+'">'+(p==='codex'?'ChatGPT · Codex':'Claude · Claude Code')+'</option>').join('')+'</select><label class="agent-consent"><input type="checkbox" id="agentPermissions" required> '+esc(QI.msg('Allow this agent to manage my workspace memory and work in its own folder.'))+'</label><button class="primary">'+esc(QI.msg('Set up my Qoopia agent'))+'</button></form>';
        }else if(data.access_error)setupHtml='<p role="alert">'+esc(QI.msg(data.access_error))+'</p><a href="#agents">'+esc(QI.msg('View agents and notes'))+'</a>';
        else if(!data.running)setupHtml='<p>'+esc(QI.msg('Your conversations are saved. Start your agent to continue.'))+'</p><button id="agentStart" class="primary">'+esc(QI.msg('Start my agent'))+'</button>';
        else if(!data.account)setupHtml='<p>'+esc(QI.msg(data.provider==='claude_code'?'Sign in to Claude to use your available Claude Code access. Your plan limits apply.':'Sign in to ChatGPT to use your available Codex access. Your plan limits apply.'))+'</p>'+(data.login?'<a class="agent-login" href="'+esc(data.login.url)+'" target="_blank" rel="noopener noreferrer">'+esc(QI.msg('Continue sign-in'))+'</a>':'<button id="agentLogin" class="primary">'+esc(QI.msg(data.provider==='claude_code'?'Sign in to Claude':'Sign in to ChatGPT'))+'</button>');
        if(data.login&&data.provider==='claude_code')setupHtml+='<form id="agentLoginCodeForm"><label for="agentLoginCode">'+esc(QI.msg('If Claude shows a sign-in code, paste it here'))+'</label><input id="agentLoginCode" type="password" autocomplete="off" maxlength="2048" required><button>'+esc(QI.msg('Complete sign-in'))+'</button></form>';
        if(data.configured&&!data.access_error)setupHtml+='<details><summary>'+esc(QI.msg('Subscription'))+': '+(data.provider==='claude_code'?'Claude':'ChatGPT')+'</summary><p>'+esc(QI.msg('Each conversation stays with its original subscription. You can return to it later.'))+'</p><form id="agentProviderForm"><label for="agentProvider">'+esc(QI.msg('Subscription'))+'</label><select id="agentProvider"><option value="codex"'+(data.provider==='codex'?' selected':'')+'>ChatGPT · Codex</option><option value="claude_code"'+(data.provider==='claude_code'?' selected':'')+'>Claude · Claude Code</option></select><button'+(data.active_conversation||data.login?' disabled':'')+'>'+esc(QI.msg('Switch subscription'))+'</button></form></details>';
        if(data.configured&&data.account)setupHtml+='<div class="agent-model-row"><label for="agentModel">'+esc(QI.msg('Model'))+'</label><select id="agentModel" '+(data.active_conversation?'disabled':'')+'><option value="">'+esc(QI.msg('Provider default'))+'</option>'+(catalogs.get(data.provider)||(data.model?[{id:data.model,name:data.model}]:[])).map(m=>'<option'+(m.id===data.model?' selected':'')+' value="'+esc(m.id)+'">'+esc(m.name)+'</option>').join('')+'</select><button type="button" id="agentModelsLoad" '+(catalogs.has(data.provider)?'hidden':'')+' title="'+esc(QI.msg('Subscription model access depends on your plan.'))+'">'+esc(QI.msg('Choose model'))+'</button></div>';
        if(data.selected_provider&&data.selected_provider!==data.provider)setupHtml+='<p role="status">'+esc(QI.msg('This conversation uses another subscription. Switch back or start a new conversation.'))+'</p>';
        if(lastSetup!==setupHtml+preparing){lastSetup=setupHtml+preparing;setup.innerHTML=setupHtml;if($('#agentSetupForm'))$('#agentSetupForm').onsubmit=async e=>{e.preventDefault();await perform({action:'setup',provider:$('#agentFirstProvider').value,acceptPermissions:true});};if($('#agentLoginCodeForm'))$('#agentLoginCodeForm').onsubmit=async e=>{e.preventDefault();const input=$('#agentLoginCode'),code=input.value;input.value='';await perform({action:'login-code',code});};if($('#agentProviderForm'))$('#agentProviderForm').onsubmit=async e=>{e.preventDefault();await perform({action:'provider',provider:$('#agentProvider').value});};if($('#agentStart'))$('#agentStart').onclick=()=>perform({action:'start'});if($('#agentLogin'))$('#agentLogin').onclick=()=>perform({action:'login'});}
        if($('#agentModelsLoad'))$('#agentModelsLoad').onclick=()=>fetchModels(data.provider);
        if($('#agentModel'))$('#agentModel').onchange=async e=>{await perform({action:'model',model:e.target.value||null});lastSetup='';await load();};
        setup.querySelectorAll('button').forEach(button=>{if(preparing)button.disabled=true;});
        $('#agentSend').disabled=preparing||!data.account||!!data.active_conversation||!!data.selected_provider&&data.selected_provider!==data.provider;$('#agentStop').hidden=!(preparing||data.active_conversation||data.telegram_setup?.queued);$('#agentStop').disabled=!(preparing||data.active_conversation||data.telegram_setup?.queued);
        allConversations=[...new Map([...allConversations,...data.conversations].map(c=>[c.id,c])).values()];if(selected&&!allConversations.some(c=>c.id===selected))allConversations.unshift({id:selected,title:data.selected_title});if(conversationOffset===0)$('#agentOlderConversations').hidden=!data.more_conversations;
        const options=allConversations.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.title)+(c.provider?' · '+(c.provider==='claude_code'?'Claude':'ChatGPT'):'')+'</option>').join('');if(lastOptions!==options){lastOptions=options;$('#agentConversation').innerHTML=options;}$('#agentConversation').value=selected||'';
        const runs=[...new Map([...olderRuns,...data.runs].map(r=>[r.id,r])).values()].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id));$('#agentOlderMessages').hidden=olderRuns.length?$('#agentOlderMessages').hidden:!data.has_older_runs;
        olderRuns=runs;
        const messages=JSON.stringify(runs);
        if(messages!==lastMessages){const box=$('#agentMessages'),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;box.innerHTML=runs.length?runs.map(run=>run.unsaved?'<article class="agent-turn"><p class="meta">'+esc(QI.msg('Not kept: this agent saves only on request.'))+'</p></article>':'<article class="agent-turn"><div class="chat-bubble chat-user"><span class="chat-author">'+esc(QI.msg('You'))+'</span><p class="agent-message">'+esc(run.prompt)+'</p></div><div class="chat-bubble chat-assistant"><span class="chat-author">qoopia</span><p class="agent-message">'+esc(run.answer||QI.msg(run.state==='starting'?'Starting…':'Waiting for a reply…'))+'</p>'+(run.error?'<p role="alert">'+esc(QI.msg(run.error))+'</p>':'')+'</div></article>').join(''):'<div class="agent-empty"><h2>'+esc(QI.msg('What would you like to do?'))+'</h2><p>'+esc(QI.msg('Try “Show what you remember” or “Help me connect another client”.'))+'</p></div>';if(bottom)box.scrollTop=box.scrollHeight;lastMessages=messages;}
        $('#agentProgress').textContent=data.active_conversation?QI.msg(data.approvals.length?'Your agent needs your answer.':'Your agent is working…'):QI.msg(data.account?'Ready for your next message.':'Start your agent and sign in to continue.');
        // Keep the next action beside the disabled composer, including in narrow panels.
        const recovery=$('#agentRecovery'),claudeCode=!!data.login&&data.provider==='claude_code';
        const recoveryHtml=!data.access_error&&!data.account&&!preparing?(claudeCode?'<button type="button" id="agentRecoverCode">'+esc(QI.msg('Continue sign-in'))+'</button>':data.login?'<a class="agent-login" href="'+esc(data.login.url)+'" target="_blank" rel="noopener noreferrer">'+esc(QI.msg('Continue sign-in'))+'</a>':'<button type="button" id="agentRecover">'+esc(QI.msg(!data.running?'Start my agent':data.provider==='claude_code'?'Sign in to Claude':'Sign in to ChatGPT'))+'</button>'):'';
        if(recovery.dataset.content!==recoveryHtml){recovery.dataset.content=recoveryHtml;recovery.innerHTML=recoveryHtml;}
        if($('#agentRecover'))$('#agentRecover').onclick=()=>perform({action:data.running?'login':'start'});
        if($('#agentRecoverCode'))$('#agentRecoverCode').onclick=()=>{setup.scrollIntoView({block:'start'});($('#agentLoginCode')||setup.querySelector('.agent-login'))?.focus();};
        const approvals=JSON.stringify(data.approvals);
        if(approvals!==lastApprovals){$('#agentApprovals').innerHTML=data.approvals.map(a=>'<section class="agent-approval"><h2>'+esc(QI.msg(a.method.includes('requestUserInput')?'Your answer':'Permission needed'))+'</h2><p>'+esc(a.params.reason||a.params.command||QI.msg('Review the requested access before continuing.'))+'</p><details><summary>'+esc(QI.msg('Details'))+'</summary><pre>'+esc(JSON.stringify(a.params,null,2))+'</pre></details>'+(a.params.questions||[]).map(q=>'<label for="question-'+esc(q.id)+'">'+esc(q.question)+'</label><input id="question-'+esc(q.id)+'" data-question="'+esc(q.id)+'">').join('')+'<div class="work-actions"><button data-approval="'+esc(a.id)+'" data-accept="true">'+esc(QI.msg(a.method.includes('requestUserInput')?'Answer':'Allow once'))+'</button><button data-approval="'+esc(a.id)+'" data-accept="false">'+esc(QI.msg('Decline'))+'</button></div></section>').join('');$('#agentApprovals').querySelectorAll('[data-approval]').forEach(b=>b.onclick=()=>{const answers=Object.fromEntries([...b.closest('section').querySelectorAll('[data-question]')].map(el=>[el.dataset.question,el.value]));perform({action:'approve',id:b.dataset.approval,accept:b.dataset.accept==='true',answers});});lastApprovals=approvals;}
        const filesKey=JSON.stringify(data.files||[]);if(filesKey!==lastFiles){lastFiles=filesKey;$('#agentFiles').innerHTML=(data.files||[]).length?'<details><summary>'+esc(QI.msg('Files in your agent folder'))+'</summary><ul>'+(data.files||[]).map(f=>'<li><a href="/api/dashboard/my-agent/file?path='+encodeURIComponent(f.path)+'" download>'+esc(f.path)+'</a> · '+humanSize(f.size)+'</li>').join('')+'</ul></details>':'';}
        const tg=data.telegram;$('#telegramForm').hidden=!!tg.username;
        const connectedHtml=tg.username?'<p>'+esc('@'+tg.username)+' · '+esc(QI.msg(tg.verified?'Reply verified':tg.linked?'Linked. Send a message to verify the reply.':data.telegram_setup?.expired?'Pairing link expired. Create a new link.':'Open the pairing link and press Start in Telegram.'))+'</p><button id="telegramDisconnect">'+esc(QI.msg('Disconnect Telegram'))+'</button>':'';
        if($('#telegramConnected').dataset.content!==connectedHtml){$('#telegramConnected').dataset.content=connectedHtml;$('#telegramConnected').innerHTML=connectedHtml;}
        if($('#telegramDisconnect'))$('#telegramDisconnect').onclick=()=>perform({action:'telegram-disconnect'});
        const pairing=data.telegram_setup?.pending,pending=pairing?.user;
        const telegramUrl=tg.linked?'https://t.me/'+tg.username:pairing?.url;
        const linkHtml=telegramUrl?'<a target="_blank" rel="noopener noreferrer" href="'+esc(telegramUrl)+'">'+esc(QI.msg(tg.linked?'Open your bot and send a message':'Open your bot and press Start'))+'</a>':data.telegram_setup?.expired?'<button id="telegramRetry">'+esc(QI.msg('Create a new pairing link'))+'</button>':'';
        if($('#telegramLink').innerHTML!==linkHtml)$('#telegramLink').innerHTML=linkHtml;
        if($('#telegramRetry'))$('#telegramRetry').onclick=()=>perform({action:'telegram-retry'});

        const confirmHtml=pending?'<p>'+esc(QI.msg('Confirm your Telegram account'))+': '+esc(pending.name)+' ('+esc(pending.id)+')</p><button id="telegramConfirmOwner">'+esc(QI.msg('This is my account'))+'</button>':'';
        if($('#telegramConfirm').dataset.content!==confirmHtml){$('#telegramConfirm').dataset.content=confirmHtml;$('#telegramConfirm').innerHTML=confirmHtml;}
        if(pending)$('#telegramConfirmOwner').onclick=()=>perform({action:'telegram-confirm',userId:pending.id,chatId:pending.chat});
        if(data.telegram_setup?.error)feedback(QI.msg(data.telegram_setup.error));else if(data.telegram_setup?.uncertain_deliveries)feedback(QI.msg('A Telegram reply could not be confirmed. Your full answer is saved in this chat.'));
      }catch(e){feedback(e.message);}finally{delete root.dataset.loading;}
    }
    $('#agentConversation').onchange=async()=>{const next=$('#agentConversation').value;try{await action({action:'select-conversation',conversation:next});selected=next;lastMessages='';olderRuns=[];await load();}catch(e){feedback(e.message);}};
    $('#agentNew').onclick=async()=>{try{const result=await action({action:'new',title:QI.resolve(QI.msg('New conversation'))});selected=result.id;olderRuns=[];await load();$('#agentText').focus();}catch(e){feedback(e.message);}};
    $('#agentOlderConversations').onclick=async()=>{try{conversationOffset+=100;const page=await api('/api/dashboard/my-agent?conversationOffset='+conversationOffset);allConversations.push(...page.conversations);data.more_conversations=page.more_conversations;await load();if(!page.more_conversations)$('#agentOlderConversations').hidden=true;}catch(e){conversationOffset-=100;feedback(e.message);}};
    $('#agentOlderMessages').onclick=async()=>{try{const first=olderRuns[0]||data.runs[0];if(!first)return;const page=await api('/api/dashboard/my-agent?conversation='+encodeURIComponent(selected)+'&runBefore='+encodeURIComponent(first.id));olderRuns=[...page.runs,...olderRuns];$('#agentOlderMessages').hidden=!page.has_older_runs;await load();}catch(e){feedback(e.message);}};
    $('#agentStop').onclick=()=>perform({action:'stop'});
    $('#agentUseDashboard').onclick=()=>perform({action:'channel',channel:'dashboard'});
    $('#agentUseTelegram').onclick=()=>{
      $('#agentChannel').open=true;
      if(data?.telegram?.linked&&/^[A-Za-z0-9_]+$/.test(data.telegram.username)){
        $('#telegramLink').innerHTML='<a target="_blank" rel="noopener noreferrer" href="https://t.me/'+esc(data.telegram.username)+'">'+esc(QI.msg('Open your bot and send a message'))+'</a>';
        const link=$('#telegramLink a');link.scrollIntoView({block:'center'});link.focus();
        if(data.telegram.verified)return perform({action:'channel',channel:'telegram'});
        feedback(QI.msg('Open your bot and send a message'));return;
      }
      const pendingLink=$('#telegramLink a')||$('#telegramRetry')||$('#telegramConfirmOwner');if(pendingLink){pendingLink.scrollIntoView({block:'center'});pendingLink.focus();return;}
      $('#telegramToken').scrollIntoView({block:'center'});$('#telegramToken').focus();feedback(QI.msg('Connect your Telegram bot below, then confirm your account.'));
    };
    $('#agentCompose').onsubmit=async e=>{e.preventDefault();const text=$('#agentText').value.trim();if(!text)return;try{if(!selected){const created=await action({action:'new',title:text.slice(0,80)});selected=created.id;}await action({action:'send',conversation:selected,requestId,text});$('#agentText').value='';requestId=crypto.randomUUID();feedback('');await load();}catch(error){feedback(error.message);}};
    $('#telegramForm').onsubmit=async e=>{e.preventDefault();const input=$('#telegramToken'),secret=input.value;input.value='';try{const result=await action({action:'telegram-connect',token:secret});$('#telegramLink').innerHTML='<a target="_blank" rel="noopener noreferrer" href="'+esc(result.url)+'">'+esc(QI.msg('Open your bot and press Start'))+'</a>';await load();}catch(error){feedback(error.message);}};
    refresh=load;void load();
    $('#agentText').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('#agentSend').disabled&&!busy)$('#agentCompose').requestSubmit();}});
  }

  return {open,dispose(){disposed=true;clearInterval(timer);document.removeEventListener('keydown',onKey);document.removeEventListener('visibilitychange',onVisible);body.replaceChildren();panel.hidden=true;launcher.hidden=true;launcher.onclick=null;launcher.setAttribute('aria-expanded','false');}};
};
