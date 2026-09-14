const view=document.querySelector('#product-view');
const dashboardImages={"en": {"memory": "assets/dashboard-memory-en-c5f2e6450753.png", "connections": "assets/dashboard-connections-en-e87b5e5288d6.png", "bridges": "assets/dashboard-bridges-en-7e3319b82885.png"}, "ru": {"memory": "assets/dashboard-memory-ru-d4ff377e6347.png", "connections": "assets/dashboard-connections-ru-7b3fb2a7c959.png", "bridges": "assets/dashboard-bridges-ru-80d4e80804b9.png"}};
const captions={memory:'Memory · save, search and continue.',connections:'Connections · separate clients, explicit access.',bridges:'Bridges · invited sharing between independent installations.'};
let currentView='memory';
function renderView(){
 if(!view)return;
 view.src=dashboardImages[QI.language]?.[currentView]||dashboardImages.en[currentView];
 view.alt=QI.msg('Qoopia {view} screen with synthetic demonstration data',{view:QI.plain({memory:'Memory',connections:'Connections',bridges:'Bridges'}[currentView])});
 document.querySelector('#view-caption').textContent=QI.msg(captions[currentView]);
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
 currentView=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));renderView();
}));
window.addEventListener('qoopia:language',renderView);renderView();
const platform=document.querySelector('#platform');
if(platform){
 if(/Linux/.test(navigator.platform)&&!/Android/.test(navigator.userAgent))platform.value='linux';
 fetch('release.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(release=>{
  function render(){
   const pkg=release.packages[platform.value];
   document.querySelector('#release-meta').textContent=QI.msg(pkg.requirements)+' '+pkg.format+' · '+QI.number(pkg.bytes/1000000)+' '+QI.msg('MB')+' · '+QI.date(release.date+'T12:00:00Z',{dateStyle:'medium'});
   const action=document.querySelector('#download-action');action.replaceChildren();
   if(release.availability==='public'&&pkg.url&&new URL(pkg.url).protocol==='https:'){
    document.querySelector('#release-state').textContent=QI.msg('{version} is available for {platform}.',{version:release.version,platform:pkg.label});
    const a=document.createElement('a');a.className='button';a.href=pkg.url;a.textContent=QI.msg('Download {format} ↓',{format:pkg.format});action.append(a);
    const checksum=document.createElement('p');checksum.className='release-meta';checksum.textContent='SHA-256: '+pkg.sha256;action.append(checksum);
   }
  }
  platform.addEventListener('change',render);render();
 }).catch(()=>{document.querySelector('#release-state').textContent=QI.msg('Release information could not be loaded. Please reload or read the release notes.');});
}
