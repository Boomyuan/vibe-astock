"""Real transport with an inert fake CLI, never vendor accounts or model quota."""
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
import pytest
from review_agent.runtime import Runtime, REPO
from review_agent.subscription_bridge import invoke, bridge_environment, subscription_status
from review_agent.evidence import EvidenceError

# fake_cli 是依赖 POSIX shebang 直执行、/bin/sleep 与 ps 的假 CLI；Windows 上
# 无法 spawn（也不会创建 pids.json），这些用例只能跑在 POSIX 环境。
posix_only = pytest.mark.skipif(os.name == 'nt', reason='fake CLI 依赖 POSIX shebang/sleep/ps，Windows 不适用')


def fake_cli(tmp_path, mode='success', require_user=False):
    target=tmp_path/'fake-claude';log=tmp_path/'calls.json';pids=tmp_path/'pids.json'
    target.write_text(f'''#!{sys.executable}
import sys,json,subprocess,os,time
from pathlib import Path
args=sys.argv[1:]
if '--version' in args: print('fake test CLI');sys.exit()
if '--help' in args: print('--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format --system-prompt --json-schema');sys.exit()
if args[:2]==['auth','status']:
 logged_in = not {require_user!r} or os.environ.get('USER') == 'subscription-test'
 print(json.dumps({{'loggedIn':logged_in,'authMethod':'claude.ai' if logged_in else 'none','apiProvider':'firstParty'}}));sys.exit(0 if logged_in else 1)
text=sys.stdin.read()
Path({str(log)!r}).write_text(json.dumps({{'args':args,'input':text,'env':{{k:os.environ[k] for k in ['ANTHROPIC_API_KEY','OPENAI_API_KEY'] if k in os.environ}}}}))
if {mode!r} != 'success':
 child=subprocess.Popen(['/bin/sleep','40'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 Path({str(pids)!r}).write_text(json.dumps([os.getpid(),child.pid]))
 time.sleep(40)
print(json.dumps({{'result':'fake response'}}))
''');target.chmod(0o700)
    return target,log,pids


def dead(pid):
    out=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True).stdout.strip()
    return not out or out.startswith('Z')


def wait_until(predicate, seconds=8):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        if predicate():return True
        time.sleep(.05)
    return False


@pytest.mark.parametrize('agent', ['claude', 'codebuddy'])
def test_subscription_environment_preserves_os_identity_without_api_routing(tmp_path, monkeypatch, agent):
    for name, value in {'USER':'test-user', 'LOGNAME':'test-user', 'SHELL':'/bin/zsh',
                        'CLAUDE_CONFIG_DIR':str(tmp_path/'claude-custom'),
                        'CLAUDE_CODE_OAUTH_TOKEN':'synthetic-subscription-token',
                        'ANTHROPIC_API_KEY':'MUST_NOT_ROUTE',
                        'ANTHROPIC_BASE_URL':'https://invalid.example',
                        'OPENAI_API_KEY':'MUST_NOT_PASS'}.items():
        monkeypatch.setenv(name, value)
    env = bridge_environment(tmp_path/'state', agent)
    assert env['USER'] == env['LOGNAME'] == 'test-user'
    assert env['SHELL'] == '/bin/zsh'
    assert not {'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY'} & env.keys()
    if agent == 'claude':
        assert env['CLAUDE_CONFIG_DIR'] == str(tmp_path/'claude-custom')
        assert env['CLAUDE_CODE_OAUTH_TOKEN'] == 'synthetic-subscription-token'
    else:
        assert not {'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'} & env.keys()


@posix_only
def test_claude_status_through_real_bridge_requires_os_user(tmp_path, monkeypatch):
    cli, _, _ = fake_cli(tmp_path, require_user=True)
    monkeypatch.setenv('CLAUDE_BIN', str(cli))
    monkeypatch.setenv('USER', 'subscription-test')
    runtime = Runtime(tmp_path/'state')
    # Reproduce the former missing-identity environment without touching logins.
    def old_environment(home, agent):
        env = bridge_environment(home, agent)
        env.pop('USER', None)
        return env
    with monkeypatch.context() as old:
        old.setattr('review_agent.subscription_bridge.bridge_environment', old_environment)
        assert subscription_status(runtime, 'claude')['available'] is False
    assert subscription_status(runtime, 'claude')['available'] is True


@posix_only
def test_bridge_stdin_and_plain_tool_isolation(tmp_path,monkeypatch):
    cli,log,_=fake_cli(tmp_path)
    monkeypatch.setenv('CLAUDE_BIN',str(cli));monkeypatch.setenv('ANTHROPIC_API_KEY','MUST_NOT_ROUTE');monkeypatch.setenv('OPENAI_API_KEY','MUST_NOT_ROUTE')
    r=Runtime(tmp_path/'state')
    assert invoke(r,tmp_path,{'provider':'claude','model':'chosen-model'},'PRIVATE_QUESTION','system',threading.Event(),lambda _:None,15,tools=())=='fake response'
    call=json.loads(log.read_text());args=call['args']
    assert 'PRIVATE_QUESTION' not in json.dumps(args) and 'PRIVATE_QUESTION' in call['input']
    assert call['env']=={} and '--safe-mode' in args and '--no-session-persistence' in args
    assert args[args.index('--tools')+1]==''
    assert args[args.index('--model')+1]=='chosen-model'
    assert json.loads(args[args.index('--mcp-config')+1])=={'mcpServers':{}}


@pytest.mark.parametrize('ending',['cancel','timeout','parent-death'])
@posix_only
def test_bridge_descendants_stop(tmp_path,monkeypatch,ending):
    cli,_,pids=fake_cli(tmp_path,'wait');monkeypatch.setenv('CLAUDE_BIN',str(cli))
    parent=None;cancel=threading.Event();timer=None;known=[]
    try:
        if ending=='parent-death':
            code="""import threading,sys
from pathlib import Path
from review_agent.runtime import Runtime
from review_agent.subscription_bridge import invoke
r=Runtime(Path(sys.argv[1]))
invoke(r,r.root,{'provider':'claude','model':'default'},'q','system',threading.Event(),lambda _:None,30,tools=())
"""
            parent=subprocess.Popen([sys.executable,'-c',code,str(tmp_path/'state')],cwd=REPO,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            assert wait_until(pids.exists)
            known=json.loads(pids.read_text());parent.kill();parent.wait(3)
        else:
            def stop_when_started():
                if wait_until(pids.exists):cancel.set()
            if ending=='cancel':timer=threading.Thread(target=stop_when_started);timer.start()
            with pytest.raises(EvidenceError):
                invoke(Runtime(tmp_path/'state'),tmp_path,{'provider':'claude','model':'default'},'q','system',cancel,lambda _:None,1 if ending=='timeout' else 15,tools=())
            known=json.loads(pids.read_text())
        assert wait_until(lambda:all(dead(p) for p in known)), f'live descendants: {known}'
    finally:
        if parent and parent.poll() is None:parent.kill();parent.wait(3)
        if timer:timer.join(10)
        if pids.exists():known=json.loads(pids.read_text())
        for pid in known:
            if not dead(pid):
                try:os.kill(pid,signal.SIGKILL)
                except ProcessLookupError:pass


def test_claude_probe_failure_is_not_reported_as_logout(tmp_path,monkeypatch):
    cli,_,_=fake_cli(tmp_path)
    cli.write_text(cli.read_text().replace('--safe-mode --tools','--tools'))
    monkeypatch.setenv('CLAUDE_BIN',str(cli))
    runtime=Runtime(tmp_path/'state')
    with pytest.raises(EvidenceError,match='状态检测未完成'):
        invoke(runtime,tmp_path/'run',{'provider':'claude','model':'default'},'test','test',threading.Event(),lambda _:None,20,tools=())


@posix_only
def test_claude_cold_start_longer_than_five_seconds_is_not_logout(tmp_path,monkeypatch):
    cli,_,_=fake_cli(tmp_path)
    cli.write_text(cli.read_text().replace("if '--version' in args: print", "if '--version' in args: time.sleep(6);print"))
    monkeypatch.setenv('CLAUDE_BIN',str(cli))
    result=subscription_status(Runtime(tmp_path/'state'),'claude')
    assert result['available'] is True and result['status']=='ready'



@posix_only
def test_claude_help_failure_retains_detected_version(tmp_path,monkeypatch):
    cli,_,_=fake_cli(tmp_path)
    cli.write_text(cli.read_text().replace("if '--help' in args: print", "if '--help' in args: sys.exit(2);print"))
    monkeypatch.setenv('CLAUDE_BIN',str(cli))
    result=subscription_status(Runtime(tmp_path/'state'),'claude')
    assert result['version']=='fake test CLI'
    assert result['status']=='probe_failed'


@posix_only
def test_claude_probe_preserves_startup_window_for_all_three_steps(tmp_path,monkeypatch):
    cli,_,_=fake_cli(tmp_path)
    cli.write_text(cli.read_text().replace("if '--version' in args: print", "if '--version' in args: time.sleep(8);print").replace("if '--help' in args: print", "if '--help' in args: time.sleep(8);print").replace(" logged_in =", " time.sleep(8)\n logged_in ="))
    monkeypatch.setenv('CLAUDE_BIN',str(cli))
    started=time.monotonic()
    result=subscription_status(Runtime(tmp_path/'state'),'claude')
    assert 23 <= time.monotonic()-started < 35
    assert result['status']=='ready' and result['version']=='fake test CLI'
