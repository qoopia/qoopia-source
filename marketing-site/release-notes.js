fetch('release.json').then(r=>{if(!r.ok)throw Error();return r.json();}).then(r=>{
 const root=document.querySelector('#packages'),version=document.createElement('p');
 version.textContent=r.tag+' · '+QI.msg('runtime {source}',{source:r.source.slice(0,7)});root.append(version);
 for(const p of Object.values(r.packages)){
  const el=document.createElement('p');el.className='release-meta';el.textContent=p.label+' · '+p.format+' · '+QI.number(p.bytes/1000000)+' '+QI.msg('MB')+' — '+p.file+' — SHA-256: '+p.sha256;root.append(el);
 }
}).catch(()=>{document.querySelector('#packages').textContent=QI.msg('Release details could not be loaded. Open the manifest below or reload.');});
