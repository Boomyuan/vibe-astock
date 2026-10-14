"""Regression scenarios from Simon's full-product use on 2026-09-08."""
from datetime import datetime
from types import SimpleNamespace
import json
import threading
import pytest
from duanxian import trade_calendar as tc
from review_agent.grounding import validate_section, request_checked
from review_agent.daily import DailyLLM
from review_agent.evidence import EvidenceError

@pytest.mark.parametrize('hour,minute,phase', [(9,14,'closed'),(9,15,'auction'),(9,24,'auction'),(9,25,'wait'),(9,29,'wait'),(9,30,'open'),(11,30,'break'),(12,59,'break'),(13,0,'open'),(14,57,'closing'),(15,0,'closed')])
def test_trading_boundaries(hour,minute,phase):
 assert tc.session_phase(datetime(2026,9,8,hour,minute),'2026-09-08')['phase_key']==phase

def test_stale_quote_does_not_enable_holiday_alerts():
 assert tc.session_phase(datetime(2026,10,1,10,0),'2026-09-30')['phase_key']=='closed'

@pytest.mark.parametrize('clock,slot,phrase',[('09:20','09:25','尚未到'),('09:20','09:20','试撮合'),('09:31','09:25','连续交易')])
def test_capture_does_not_archive_trial_or_late_auction(monkeypatch,clock,slot,phrase):
 from duanxian import intraday
 monkeypatch.setattr(intraday,'china_today',lambda:'2026-09-08')
 monkeypatch.setattr(intraday,'china_now',lambda:datetime.fromisoformat('2026-09-08T'+clock))
 monkeypatch.setattr(tc,'quote_trade_day',lambda:'2026-09-08')
 r=intraday.capture(slot)
 assert not r['ok'] and phrase in r['reason']

def test_auction_return_uses_opening_price_not_latest(monkeypatch):
 from duanxian import emotion_metrics as em
 f=['']*55;f[0]='v_sh600000="';f[4]='10';f[5]='10.2';f[30]='20260908092600';f[32]='9.9'
 # 行情源已改为 build_opener(ProxyHandler({})) 直连，补丁落在 build_opener 上
 _resp=lambda:SimpleNamespace(read=lambda:'~'.join(f).encode())
 monkeypatch.setattr(em.urllib.request,'build_opener',lambda *a,**k:SimpleNamespace(open=lambda *a2,**k2:_resp()))
 assert em.batch_pct(['600000'],opening_date='2026-09-08')['600000']==pytest.approx(2)
 f[5]='0';assert em.batch_pct(['600000'],opening_date='2026-09-08')=={}

def test_trial_limit_price_is_not_sealed_board():
 from vr.previous_ladder import render_cohort
 c={'quote_date':'2026-09-08','stocks':[{'code':'600000','boards':3}]}
 q={'600000':{'price':11,'zt_price':11,'high':0,'quote_time':'20260908091800','pct':10}}
 assert render_cohort(c,q,phase='auction')['stocks'][0]['status']=='竞价试撮合'
 q['600000']['quote_time']='20260908094000'
 assert render_cohort(c,q,phase='open')['stocks'][0]['status']=='封板中'

def test_cited_numeric_stock_name_does_not_disable_number_guard():
 records=[{'id':'ev-a','input':'get_leader_data','text':'  百大集团(3板·一般零售)'}]
 def obj(text):return {'findings':[{'text':text,'citations':['ev-a']}]}
 assert validate_section(obj('百大集团处于次高梯队。'),records)
 for text in ['百大集团涨停九家','百大集团上涨99%','百万集团处于次高梯队']:
  with pytest.raises(EvidenceError):validate_section(obj(text),records)
 with pytest.raises(EvidenceError):validate_section(obj('百大集团处于次高梯队。'),[{**records[0],'input':'get_theme_reasons'}])

def test_real_daily_adapter_allows_bounded_content_correction_and_private_diagnostics(tmp_path):
 records=[{'id':'ev-a','input':'get_leader_data','text':'甲(3板·测试)'}]
 responses=iter(['{"findings":[{"text":"低吸 CANARY_PRIVATE_KEY","citations":["ev-a"]}]}','{"findings":[{"text":"样本承接存在分歧。","citations":["ev-a"]}]}'])
 class Runtime:
  timeout=60
  def _invoke(self,*args,**kwargs):return next(responses)
 llm=DailyLLM(Runtime(),{},'CANARY_PRIVATE_KEY',tmp_path,'2026-09-07',threading.Event(),lambda:50)
 result=request_checked(llm,'分析',{'stage':'leader','records':records},lambda o:validate_section(o,records))
 assert result['findings'][0]['text']=='样本承接存在分歧。'
 diagnostics=list(tmp_path.glob('*/validation.json'));assert len(diagnostics)==1
 raw=diagnostics[0].read_text();assert 'CANARY_PRIVATE_KEY' not in raw and '[redacted]' in raw
 assert json.loads(raw)['is_evidence'] is False

def test_completed_kline_excludes_intraday_volume(monkeypatch):
 import pandas as pd
 import akshare
 from duanxian.deepdive import data
 rows=[{'date':f'2026-09-{i:02d}','close':10+i,'volume':100} for i in range(1,9)]
 rows[-1]['volume']=0
 monkeypatch.setattr(akshare,'stock_zh_a_hist_tx',lambda **kw:pd.DataFrame(rows))
 monkeypatch.setattr(data,'china_now',lambda:datetime(2026,9,8,9,20))
 monkeypatch.setattr(data,'is_a_share_closed',lambda:False)
 text=data.get_kline('600000')
 assert '截至 2026-09-07' in text and '1.0 倍' in text and '连涨' in text and '连阳' not in text

def test_weekly_keeps_tied_highest(monkeypatch):
 import pandas as pd
 from duanxian import weekly
 monkeypatch.setattr(weekly,'_last_trade_dates',lambda n:['2026-09-07'])
 monkeypatch.setattr(weekly.dr,'fetch_zt_pool',lambda d:{'zt':pd.DataFrame({'x':[1,2]}),'highest_consec':3,'ladder':[{'code':'600001','name':'甲','consec_boards':3},{'code':'600002','name':'乙','consec_boards':3}]})
 monkeypatch.setattr(weekly,'_followthrough',lambda *args:[])
 report=weekly.build_weekly()
 assert len(report['days'][0]['leaders'])==2
 assert all(r['is_current_top'] and r['series_warning'] for r in report['leader_lineage'])


def test_multiday_record_does_not_hide_same_day_unsellable_inventory():
 from duanxian.journal import _settle
 def f(day,side,shares): return dict(date=day,side=side,shares=shares,price=10,fee=0)
 base=[f('2026-09-07','buy',100),f('2026-09-08','buy',100)]
 good=_settle(base+[f('2026-09-08','sell',100)])
 assert 'settlement_warning' not in good
 bad=_settle(base+[f('2026-09-08','sell',200)])
 assert bad['closed'] and bad['hold_days']==1 and bad['settlement_warning']
 assert bad['is_t0'] is False


def test_legacy_auction_without_opening_price_proof_cannot_be_reused(monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday,'load_day',lambda d:{'slots':[{'slot':'09:25','captured_at':'2026-09-08 09:20:00 CST'}]})
 result=intraday.auction_check('2026-09-08')
 assert result['available'] is False and '旧竞价快照' in result['reason']

@pytest.mark.parametrize('name',['三六零','二三四五','七匹狼','九安医疗','三花智控','万科A','TCL科技'])
def test_all_cited_company_names_are_entities_not_quantities(name):
 records=[{'id':'ev-a','input':'get_leader_data','text':f'  {name}(3板·行业)'}]
 def obj(text):return {'findings':[{'text':text,'citations':['ev-a']}]}
 assert validate_section(obj(f'{name}处于次高梯队。'),records)
 with pytest.raises(EvidenceError):validate_section(obj(f'{name}上涨99%'),records)


def test_flow_total_guard_allows_caution_but_rejects_numeric_total():
 from review_agent.daily import has_unsupported_flow_total
 assert not has_unsupported_flow_total('各条记录未跨区间累计净买额，单日和三日榜存在重叠。')
 assert not has_unsupported_flow_total('禁止汇总净流入。')
 assert has_unsupported_flow_total('全期合计净流入0.25亿元。')
 assert has_unsupported_flow_total('净买额合计为-0.24亿。')

def test_holiday_afternoon_is_not_premarket():
 r=tc.session_phase(datetime(2026,10,1,14,0),'2026-09-30')
 assert r['phase']=='尚无今日行情' and not r['poll']

def test_invalid_old_capture_excluded_but_file_preserved(tmp_path,monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday,'_day_dir',lambda d:str(tmp_path))
 for slot in ['09:20','09:25','10:00']:
  (tmp_path/(slot.replace(':','')+'.json')).write_text(json.dumps({'schema':3,'date':'2026-09-08','slot':slot,'captured_at':'2026-09-08 '+slot+':00 CST'}))
 r=intraday.load_day('2026-09-08')
 assert [s['slot'] for s in r['slots']]==['10:00'] and len(r['warnings'])==2
 assert len(list(tmp_path.glob('*.json')))==3

def test_oversell_inventory_is_chronological_even_on_direct_call():
 from duanxian.journal import _settle
 def f(day,side,shares):return dict(date=day,side=side,shares=shares,price=10,fee=0)
 assert _settle([f('2026-09-08','buy',100),f('2026-09-07','buy',100),f('2026-09-08','sell',200)])['settlement_warning']

def test_full_execution_archive_with_bounded_preview(tmp_path):
 import zipfile
 from review_agent.backtesting import execution_view
 fills=[{'fee':i,'reason':'测试成交'} for i in range(30000)]
 equity=[{'date':str(i),'equity':i+100} for i in range(6000)]
 (tmp_path/'fills.jsonl').write_text('\n'.join(json.dumps(f,ensure_ascii=False) for f in fills),encoding='utf-8')
 (tmp_path/'equity.csv').write_text('timestamp,equity\n'+ '\n'.join(f"{x['date']},{x['equity']}" for x in equity),encoding='utf-8')
 result=execution_view(fills,equity,tmp_path)
 assert result['fills_total']==30000 and len(result['fills'])==200
 assert result['equity_total']==6000 and len(result['equity'])==500
 assert result['equity'][0]==equity[0] and result['equity'][-1]==equity[-1]
 assert len(json.dumps(result).encode())<100000
 with zipfile.ZipFile(tmp_path/'execution.zip') as z:
  assert len(z.read('fills.jsonl').splitlines())==30000 and len(z.read('equity.csv').splitlines())==6001

def test_execution_export_rejects_outside_link(tmp_path):
 from review_agent.backtesting import execution_archive
 job='a'*32
 folder=tmp_path/job/'calculation'/'artifacts';folder.mkdir(parents=True)
 outside=tmp_path/'outside.zip';outside.write_bytes(b'private')
 (folder/'execution.zip').symlink_to(outside)
 jobs=SimpleNamespace(directory=tmp_path,status=lambda id:{'status':'complete','backtest_result':{'ok':True}})
 with pytest.raises(EvidenceError):execution_archive(jobs,job)


def test_filtered_auction_explains_present_but_invalid_archive(monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday, 'load_day', lambda date: {'slots': [], 'warnings': ['09:25 旧快照未证明为有效成交时点']})
 monkeypatch.setattr(intraday, 'capture', lambda *a: {'ok': False, 'reason': '已进入连续交易'})
 result = intraday.auction_check('2026-09-08')
 assert not result['available'] and '旧快照已排除' in result['reason']
 assert result['warnings']


def test_single_stock_timing_does_not_claim_identical_drawdown():
 from backtest.gate import plan_backtest
 plan = plan_backtest(codes=['600519.SH'], start='2025-01-01', end='2025-12-31', style='swing')
 assert any('不能等同于标的自身回撤' in n for n in plan.notes)


def test_corrupt_intraday_file_is_preserved_and_explained(tmp_path, monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday, '_day_dir', lambda date: str(tmp_path))
 broken=tmp_path/'09-25.json';broken.write_text('{broken')
 result=intraday.load_day('2026-09-08')
 assert result['slots']==[] and '解析失败' in result['warnings'][0]
 assert broken.read_text()=='{broken'


def test_intraday_noncanonical_slot_is_excluded(tmp_path, monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday, '_day_dir', lambda date: str(tmp_path))
 file=tmp_path/'925.json'
 file.write_text(json.dumps({'schema':3,'slot':'9:25','captured_at':'2026-09-08 09:26:00 CST'}))
 result=intraday.load_day('2026-09-08')
 assert result['slots']==[] and '时点格式无效' in result['warnings'][0]
 assert file.exists()


def test_missing_intraday_directory_has_warning_list(tmp_path, monkeypatch):
 from duanxian import intraday
 monkeypatch.setattr(intraday, '_day_dir', lambda date: str(tmp_path/'missing'))
 assert intraday.load_day('2026-09-08')['warnings']==[]


def test_auction_success_preserves_other_archive_warnings(monkeypatch):
 from duanxian import intraday, reflection
 snap={'slot':'09:25','basis_key':'open_vs_prev_close','captured_at':'2026-09-08 09:26:00 CST',
       'sample':1,'avg':1,'median':1,'up_count':1,'down_count':0,'up_rate':100,'deep_loss_5':0,
       'by_tier':[],'top_boards':[],'top_board_level':1}
 monkeypatch.setattr(intraday, 'load_day', lambda date: {'slots':[snap], 'warnings':['存档读取失败，原件保留']})
 monkeypatch.setattr(reflection, '_load_review', lambda date: None)
 result=intraday.auction_check('2026-09-08')
 assert result['available'] and result['warnings']==['存档读取失败，原件保留']
