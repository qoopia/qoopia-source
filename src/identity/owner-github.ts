import {escapeHtml as e} from './newsletter.ts';

type Row=Record<string,unknown>;
type Dataset={status:string;observed_at?:string;error?:string;items?:Row[];data?:Row;truncated?:boolean;total_count?:number;window?:string};
export type GitHubReport={observed_at:string;repositories:{nameWithOwner:string;isPrivate:boolean;isArchived:boolean;url:string;datasets:Record<string,Dataset>}[]};
export type GitHubHistory={metric:string;day:string;value:number;dimensions:Record<string,string>}[];
export function githubPanel(report:GitHubReport|null|undefined,history:GitHubHistory|undefined,ru:boolean,sourceOk:boolean){
 const t=(en:string,r:string)=>ru?r:en;
 const text=(v:unknown)=>e(String(v??'—'));
 const link=(url:unknown,label:unknown)=>{try{const u=new URL(String(url));if(u.protocol==='https:'&&u.hostname==='github.com'&&!u.username&&!u.password)return `<a href="${e(u.href)}" target="_blank" rel="noopener noreferrer">${text(label)}</a>`;}catch{/* Untrusted provider URL is displayed as plain text. */}return text(label);};
 const table=(heads:string[],rows:string[][])=>`<div class="owner-table" tabindex="0" role="region" aria-label="${e(heads.join(', '))}"><table><thead><tr>${heads.map(x=>`<th scope="col">${e(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 const unavailable=t('Unavailable; not zero','Недоступно, а не ноль');
 if(!report||!Array.isArray(report.repositories))return `<section id="github"><h2>GitHub</h2><p>${t('Repository collection has not arrived yet.','Данные репозиториев пока не получены.')}</p></section>`;
 const age=Date.now()-Date.parse(report.observed_at),fresh=sourceOk&&Number.isFinite(age)&&age>=-300000&&age<7200000;
 const names:Record<string,string>={repository:t('Repository','Репозиторий'),issues:'Issues',pull_requests:'Pull requests',discussions:t('Discussions','Обсуждения'),forks:t('Forks','Форки'),stargazers:t('Stars: accounts','Звёзды: аккаунты'),watchers:t('Watchers','Наблюдатели'),contributors:t('Contributors','Участники'),releases:t('Releases and files','Релизы и файлы'),actions:'CI / Actions',commits:t('Recent commits','Последние коммиты'),events:t('Recent activity','Последняя активность'),branches:t('Branches','Ветки'),tags:t('Tags','Теги'),languages:t('Languages (bytes)','Языки (байты)'),community:t('Community profile','Оформление репозитория'),milestones:t('Milestones','Этапы'),labels:t('Labels','Метки'),traffic_views:t('Views','Просмотры'),traffic_clones:t('Clones','Клонирования'),traffic_popular_paths:t('Popular pages','Популярные страницы'),traffic_popular_referrers:t('Referring sites','Источники переходов')};
 const repositories=report.repositories.slice(0,100).map(repo=>{
  const d=repo.datasets,meta=d.repository?.status==='ok'?d.repository.data:undefined;
  const value=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?text(v):'—';
  const traffic=(kind:string,field:string)=>d['traffic_'+kind]?.status==='ok'?value(d['traffic_'+kind].data?.[field]):'—';
  const lists=Object.entries(names).filter(([key])=>!['repository','traffic_views','traffic_clones'].includes(key)).map(([key,label])=>{
   const dataset=d[key];let body='';
   if(!dataset||dataset.status!=='ok')body=`<p>${unavailable}${dataset?.error?`: ${text(dataset.error)}`:''}</p>`;
   else if(dataset.items){
    let items=dataset.items;
    if(key==='issues')items=items.filter(x=>x.kind==='issue');
    if(['issues','pull_requests'].includes(key))items=[...items].sort((a,b)=>Number(b.state==='open')-Number(a.state==='open'));
    const rows=items.slice(0,50).map(x=>{
     const label=x.title??x.full_name??x.login??x.name??x.type??x.path??x.referrer??x.sha??x.number??x.id;
     const detail=x.state??x.conclusion??x.status??x.contributions??x.count??x.protected??(x.answered===true?t('Answered','Есть ответ'):'');
     return [link(x.html_url,label),text(x.account??''),text(detail),text(x.updated_at??x.created_at??x.published_at??'')];
    });
    body=rows.length?table([t('Item','Объект'),t('Account','Аккаунт'),t('State / count','Статус / число'),t('Date (UTC)','Дата (UTC)')],rows):`<p>${t('No entries returned by GitHub.','GitHub не вернул записей.')}</p>`;
    if(key==='releases'){
     const assets=items.flatMap(r=>(Array.isArray(r.assets)?r.assets:[]).map((a:Row)=>[text(r.tag_name),link(a.browser_download_url,a.name),value(a.download_count),value(a.size)]));
     body+=assets.length?table([t('Release','Релиз'),t('File','Файл'),t('Downloads','Загрузки'),t('Bytes','Байты')],assets.slice(0,100)):'';
    }
    if(dataset.truncated||items.length>50)body+=`<p>${t('Bounded list; open GitHub for the complete current view.','Список ограничен; полное текущее состояние смотрите на GitHub.')}</p>`;
    if(dataset.window)body+=`<p>${text(dataset.window)}</p>`;
   }else if(dataset.data)body=table([t('Metric','Показатель'),t('Value','Значение')],Object.entries(dataset.data).map(([k,v])=>[text(k),text(v)]));
   return [key,`<details><summary>${e(label)}${dataset?.items?` · ${dataset.items.filter(x=>key!=='issues'||x.kind==='issue').length}${dataset.truncated?'+':''}`:''}</summary>${body}</details>`] as const;
  });
  const mainKeys=['issues','pull_requests','discussions','forks','releases','traffic_popular_referrers'];
  const mainLists=lists.filter(([key])=>mainKeys.includes(key)).map(([,html])=>html).join('');
  const extraLists=lists.filter(([key])=>!mainKeys.includes(key)).map(([,html])=>html).join('');
  const days=(history??[]).filter(x=>x.dimensions.repository===repo.nameWithOwner&&x.dimensions.period==='day');
  const dates=[...new Set(days.map(x=>x.day))].sort().reverse().slice(0,90);
  const daily=dates.map(day=>[text(day),...['views_count','views_uniques','clones_count','clones_uniques'].map(metric=>value(days.find(x=>x.day===day&&x.metric===metric)?.value))]);
  const trends=(history??[]).filter(x=>x.dimensions.repository===repo.nameWithOwner&&!x.dimensions.period);
  const trendDays=[...new Set(trends.map(x=>x.day))].sort().reverse().slice(0,90);
  return `<details${repo.nameWithOwner==='qoopia/qoopia-source'?' open':''}><summary>${text(repo.nameWithOwner)} · ${repo.isPrivate?t('private','приватный'):t('public','публичный')}${repo.isArchived?' · archived':''}</summary><p>${link(repo.url,t('Open repository','Открыть репозиторий'))} · ${link(repo.url+'/graphs/traffic',t('Traffic on GitHub','Трафик на GitHub'))}</p>
   ${table([t('Stars','Звёзды'),t('Forks','Форки'),t('Watchers','Наблюдатели'),t('Open issues + PR','Открытые issues + PR')],[[value(meta?.stargazers_count),value(meta?.forks_count),value(meta?.subscribers_count),value(meta?.open_issues_count)]])}
   <p>${t('A dash means unavailable, not zero.','Прочерк означает недоступные данные, а не ноль.')}</p><h3>${t('Traffic · last 14 days','Трафик · последние 14 дней')}</h3>${table([t('Views','Просмотры'),t('Unique visitors','Уникальные посетители'),t('Clones','Клонирования'),t('Unique cloners','Уникальные клонирующие')],[[traffic('views','count'),traffic('views','uniques'),traffic('clones','count'),traffic('clones','uniques')]])}
   <details><summary>${t('Daily history','История по дням')}</summary><p>${t('UTC days, up to 90 days shown. Missing days are unknown. Daily unique counts cannot be summed into unique people.','Дни по UTC, показано до 90 дней. Пропущенные дни неизвестны. Уникальных за разные дни нельзя складывать в число людей.')}</p>${daily.length?table(['UTC',t('Views','Просмотры'),t('Unique visitors','Посетители'),t('Clones','Клоны'),t('Unique cloners','Клонирующие')],daily):`<p>${t('No history yet.','Истории пока нет.')}</p>`}${trendDays.length?table(['UTC',t('Stars','Звёзды'),t('Forks','Форки'),t('Watchers','Наблюдатели')],trendDays.map(day=>[text(day),...['stargazers_count','forks_count','subscribers_count'].map(metric=>value(trends.find(x=>x.day===day&&x.metric===metric)?.value))])):''}</details>${mainLists}<details><summary>${t('More repository data','Остальные данные репозитория')}</summary>${extraLists}</details>
   <details><summary>${t('Coverage and freshness','Полнота и свежесть')}</summary>${table([t('Source','Источник'),t('Status','Состояние'),t('Checked (UTC)','Проверено (UTC)')],Object.entries(d).map(([key,x])=>[text(names[key]??key),text(x.status+(x.error?' · '+x.error:'')+(x.truncated?' · limited':'')),text(x.observed_at??'—')]))}</details></details>`;
 }).join('');
 return `<section id="github"><h2>${t('All Qoopia repositories','Все репозитории Qoopia')}</h2><p role="status">${fresh?t('GitHub collection is current.','Данные GitHub свежие.'):t('GitHub collection is unavailable or stale. Last known values are shown.','Сбор GitHub недоступен или устарел. Показаны последние известные значения.')} ${text(report.observed_at)}</p><p>${t('Collected hourly while the Mac provider bridge is running. GitHub traffic may update later. Private repository activity includes internal work.','Сбор каждый час при работающем сборщике на Mac. GitHub может обновлять трафик с задержкой. Приватный репозиторий включает внутреннюю работу.')}</p>${repositories}<p>${t('Clones are not installations. GitHub does not disclose downloader identities, countries, operating systems, local usage or source-archive download counts. Referrers describe page visits. Public forks show accounts that published a copy.','Клоны — не установки. GitHub не раскрывает личности скачавших, страны, ОС, локальное использование и число скачиваний архивов исходников. Источники переходов относятся к посещению страниц. У публичных форков видны аккаунты, опубликовавшие копию.')}</p></section>`;
}
