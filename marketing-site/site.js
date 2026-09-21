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
  platform.addEventListener('change',render);window.addEventListener('qoopia:language',render);render();
 }).catch(()=>{document.querySelector('#release-state').textContent=QI.msg('Release information could not be loaded. Please reload or read the release notes.');});
}

function renderGuideLinks(){
 const primary=document.querySelector('#fit-guide'),alternate=document.querySelector('#fit-alternate');
 if(!primary||!alternate)return;
 const ru=QI.language==='ru';primary.href=ru?'/understand-ru':'/understand';
 alternate.href=ru?'/understand':'/understand-ru';alternate.lang=ru?'en':'ru';alternate.textContent=ru?'Read in English':'Читать по-русски';
}
window.addEventListener('qoopia:language',renderGuideLinks);renderGuideLinks();

// Public installation stays unavailable until the external build is approved by Apple.
const iosInstall=document.querySelector('[data-ios-install]');
if(iosInstall){
 fetch('/ios-release.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(release=>{
  function render(){
   iosInstall.replaceChildren();
   if(release.status==='available'&&/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(release.public_url)){
    const a=document.createElement('a');a.className='button';a.href=release.public_url;a.textContent=QI.msg('Install on iPhone');iosInstall.append(a);
   }else{
    const p=document.createElement('p');p.className='notice';p.setAttribute('role','status');p.textContent=QI.msg(release.status==='review'?'Apple is reviewing the public beta. Installation will open here after approval.':'The public beta is being prepared. Installation will open here after Apple approval.');iosInstall.append(p);
   }
  }
  window.addEventListener('qoopia:language',render);render();
 }).catch(()=>{}); // The static status remains useful when release metadata is unavailable.
}
