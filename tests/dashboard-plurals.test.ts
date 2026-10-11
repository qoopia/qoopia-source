// F-520-plurals: counts glued to one fixed Russian form read "2 сообщений", "1 токенов", "3 результатов",
// "Загрузка 1 файлов…". Every dashboard count now goes through QI.count, which picks the plural form.
import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {dashboardScript} from './helpers/dashboard-source.ts';

const runtime=readFileSync(new URL('../src/public/brand/i18n.js',import.meta.url),'utf8');
function QI(lang:'ru'|'en'){
 const window:any={addEventListener(){},dispatchEvent(){}};
 runInNewContext(runtime,{window,document:{cookie:'',documentElement:{},addEventListener(){}},location:{search:'?lang='+lang,hostname:'x'},localStorage:{getItem:()=>null},navigator:{language:lang},
  crypto:globalThis.crypto,Intl,URLSearchParams,RegExp,Map,JSON,Number,String,Array,Date,CustomEvent:class{}});
 return window.QI;
}

test('message, token, result and file counts take the right Russian plural form',()=>{
 const ru=QI('ru'),en=QI('en'),say=(q:any,v:number,unit:string)=>q.resolve(q.count(v,unit));
 expect([1,2,5,21,22,25].map(n=>say(ru,n,'message'))).toEqual(['1 сообщение','2 сообщения','5 сообщений','21 сообщение','22 сообщения','25 сообщений']);
 expect([1,3,11].map(n=>say(ru,n,'token'))).toEqual(['1 токен','3 токена','11 токенов']);
 expect([1,4,7].map(n=>say(ru,n,'result'))).toEqual(['1 результат','4 результата','7 результатов']);
 expect([1,2].map(n=>say(en,n,'result'))).toEqual(['1 result','2 results']);
 // No count in the dashboard is concatenated with a fixed word any more.
 expect(dashboardScript).not.toMatch(/(_count|\.length|\.total\)?) *\+ *\(?" " *\+ *QI\.msg\(/);
 for(const unit of ['message','token','result','file'])expect(dashboardScript).toContain(", '"+unit+"')");
});
