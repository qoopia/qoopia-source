/** The longest head of `text` that, after `prefix`, fits the model's input: its token ids and how many
 * characters of `text` they cover. Kept apart from the worker so it is tested without the model.
 * A prefix that alone is over the limit (a heading of ligatures that normalise into many characters)
 * cannot be fitted by shortening the text. It is refused: the loop used to stay at one character for
 * ever, until the caller's timeout killed the worker, on every attempt [5.0.25]. */
export function fitPassage(encode:(text:string)=>number[],prefix:string,text:string,limit=512) {
  for(let end=text.length;;end=Math.floor(end*0.75)) {
    const ids=encode(prefix+text.slice(0,end));
    if(ids.length<=limit)return {ids,end};
    if(end<=1)throw new Error('Passage heading alone exceeds the built-in model input');
  }
}
