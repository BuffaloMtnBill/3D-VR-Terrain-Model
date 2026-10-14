/* Direct silhouette ridge editing. Run scripts/browser_fixture_server.py first. */
const {chromium}=require(process.env.TERRAIN_PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const url=process.env.TERRAIN_TEST_URL||'http://127.0.0.1:8001';
const outline=(page,test)=>page.waitForResponse(r=>/\/api\/silhouette\/[^/]+\/outline$/.test(r.url())&&test(r.request().postDataJSON()));
const screenPoint=(page,id)=>page.locator(`.sil-ridge-hit[data-ridge="${id}"]`).evaluate(element=>{
  const p=element.getPointAtLength(element.getTotalLength()*.5),at=new DOMPoint(p.x,p.y).matrixTransform(element.getScreenCTM());
  return {x:at.x,y:at.y};
});

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.TERRAIN_CHROMIUM_PATH,
    args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const context=await browser.newContext({viewport:{width:1500,height:950},acceptDownloads:true});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(/^https:\/\/tile\./,route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'}));
    await page.goto(url);
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    let response=outline(page,()=>true);
    await page.locator('#silhouette-button').click();
    const original=await (await response).json();
    assert.equal(original.ridge_curves.length,3);
    await page.locator('#silhouette-ridge-edit').click();
    assert.equal(await page.locator('.sil-ridge-hit').count(),3);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

    // Pull the back curve with actual pointer movement; only its local neighborhood changes.
    let at=await screenPoint(page,2);
    response=outline(page,b=>b.ridge_edits?.some(e=>e.layer===2&&e.curve.length));
    await page.mouse.move(at.x,at.y);await page.mouse.down();
    await page.mouse.move(at.x+15,at.y-25,{steps:8});await page.mouse.up();
    const draggedResponse=await response,draggedBody=draggedResponse.request().postDataJSON(),dragged=await draggedResponse.json();
    const edit=draggedBody.ridge_edits.find(e=>e.layer===2);
    assert.ok(edit.curve.length>=257);
    assert.notDeepEqual(dragged.ridge_curves[2].curve,original.ridge_curves[2].curve);
    assert.deepEqual(dragged.ridge_curves[0].curve,original.ridge_curves[0].curve);
    assert.equal(edit.curve[0][0],0);assert.equal(edit.curve.at(-1)[0],1);
    assert.ok(Math.abs(dragged.ridge_curves[2].curve[0][1]-original.ridge_curves[2].curve[0][1])<.001);

    response=outline(page,b=>b.ridge_edits?.length===0);
    await page.locator('#silhouette-ridge-undo').click();await response;
    response=outline(page,b=>b.ridge_edits?.some(e=>e.layer===2&&e.curve.length));
    await page.locator('#silhouette-ridge-redo').click();await response;
    await page.waitForFunction(()=>!document.getElementById('silhouette-ridge-undo').disabled);

    // Escape cancels a drag without committing a curve or closing the dialog.
    at=await screenPoint(page,2);
    await page.mouse.move(at.x,at.y);await page.mouse.down();await page.mouse.move(at.x,at.y+15,{steps:4});
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(await page.locator('#silhouette').isVisible(),true);

    // Delete multiple selected ridges, keeping the same middle curve and rebuilding the fit for one panel.
    await page.locator('#silhouette-ridge-list input[data-ridge="0"]').check();
    await page.locator('#silhouette-ridge-list input[data-ridge="2"]').check();
    response=outline(page,b=>b.ridge_edits?.filter(e=>e.deleted).length===2);
    await page.locator('#silhouette-ridge-delete').click();
    const remaining=await (await response).json();
    assert.deepEqual(remaining.ridge_curves.map(c=>c.layer),[1]);
    assert.deepEqual(remaining.ridge_curves[0].curve,original.ridge_curves[1].curve);
    assert.equal(remaining.fit.comb_base,null);
    await page.waitForFunction(()=>document.querySelectorAll('.sil-ridge-hit').length===1);
    await page.locator('#silhouette-ridge-list input').check();
    assert.equal(await page.locator('#silhouette-ridge-delete').isDisabled(),true,'Cannot delete the last ridge');
    response=outline(page,b=>!b.ridge_edits?.some(e=>e.deleted));
    await page.locator('#silhouette-ridge-undo').click();await response;
    await page.waitForFunction(()=>document.querySelectorAll('.sil-ridge-hit').length===3);

    // Delete key works on selected ridges, while text input retains ordinary Backspace behavior.
    await page.locator('#silhouette-ridge-list input[data-ridge="0"]').check();
    await page.locator('#silhouette-ridge-list input[data-ridge="0"]').focus();
    response=outline(page,b=>b.ridge_edits?.some(e=>e.layer===0&&e.deleted));
    await page.keyboard.press('Delete');await response;
    response=outline(page,b=>b.text==='TEST');
    await page.locator('#silhouette-text').fill('TESTX');await page.keyboard.press('Backspace');
    await response;
    assert.equal(await page.locator('#silhouette-text').inputValue(),'TEST');

    // Export requests carry the exact edits, and browser reload restores both deleted and reshaped ridges.
    const request=page.waitForRequest(r=>/\/api\/silhouette\/[^/]+\/export$/.test(r.url()));
    const download=page.waitForEvent('download');
    await page.locator('[data-silhouette-export="3mf"]').click();
    const exported=(await request).postDataJSON();await download;
    assert.ok(exported.ridge_edits.some(e=>e.layer===0&&e.deleted));
    assert.deepEqual(exported.ridge_edits.find(e=>e.layer===2).curve,edit.curve);
    await page.reload();
    await page.waitForFunction(()=>document.getElementById('scene-detail').textContent.includes('160 × 117'));
    response=outline(page,b=>b.ridge_edits?.some(e=>e.layer===0&&e.deleted));
    await page.locator('#silhouette-button').click();
    const restored=await (await response).json();
    assert.deepEqual(restored.ridge_curves.map(c=>c.layer),[1,2]);
    await page.locator('#silhouette-ridge-edit').click();
    await fs.mkdir(path.join(__dirname,'../test-results'),{recursive:true});
    await page.screenshot({path:path.join(__dirname,'../test-results/silhouette-ridge-edit.png')});
    response=outline(page,b=>b.ridge_edits?.length===0);
    await page.locator('#silhouette-ridge-reset').click();await response;
    await page.waitForFunction(()=>document.querySelectorAll('.sil-ridge-hit').length===3);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.getElementById('silhouette').scrollWidth<=innerWidth),true,'Editing tools fit a narrow screen');
    await page.screenshot({path:path.join(__dirname,'../test-results/silhouette-ridge-edit-mobile.png')});
    assert.deepEqual(errors,[]);
    console.log('Ridgeline dragging, cancellation, multi-delete, Undo/Redo, last-ridge guard, export, and persistence passed.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
