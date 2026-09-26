import {newStore} from './stores.js';

export function createStoreUi({
 getRoot,
 getState,
 persistChange,
 openDialog,
 el,
 button,
 field,
 hint,
 commit,
 render
}){
 function openStores(){
  const root=getRoot();
  const state=getState();
  const body=openDialog('店舗管理');

  hint(body,'従業員・固定作業・シフト・備考は店舗ごとに保存します。新しい店舗は空の状態で作成します。');
  body.append(el('p',{},`選択中：${state.store}`));

  const rename=el('input',{maxlength:40,value:state.store});
  const error=el('p',{class:'error',role:'alert'});

  const validName=input=>{
   const name=input.value.trim();
   if(!name){
    error.textContent='店名を入力してください。';
    return null;
   }
   if(root.stores.some(store=>store.id!==state.id&&store.store===name)){
    error.textContent='同じ店名が登録されています。';
    return null;
   }
   return name;
  };

  body.append(
   field('選択中の店名',rename),
   button('店名を変更',()=>{
    const name=validName(rename);
    if(name&&name!==state.store&&confirm(`「${state.store}」を「${name}」に変更しますか？`)){
     commit(()=>state.store=name);
    }
   }),
   el('hr')
  );

  const input=el('input',{maxlength:40,placeholder:'例：駅前店'});
  body.append(
   field('新しい店舗の店名',input),
   error,
   button('店舗を追加',()=>{
    const name=input.value.trim();
    if(!name||root.stores.some(store=>store.store===name)){
     error.textContent='重複しない店名を入力してください。';
     return;
    }
    const added=newStore(name,state.current,crypto.randomUUID());
    commit(()=>{
     root.stores.push(added);
     root.activeStoreId=added.id;
    });
   },'primary')
  );
 }

 function selectStore(id){
  if(persistChange(()=>{
   getRoot().activeStoreId=id;
  },false)){
   render();
   return true;
  }
  return false;
 }

 return {openStores,selectStore};
}
