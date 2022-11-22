const util = require('util');
const net = require('net');     // Socket
const mqtt = require('mqtt');

const CONFIG = require('/data/options.json');  //**** 애드온의 옵션을 불러옵니다. 이후 CONFIG.mqtt.username 과 같이 사용가능합니다. 

const CONST = {
    // 포트이름 설정/dev/ttyUSB0
    portName: process.platform.startsWith('win') ? "COM6" : CONFIG.serial.port,
    // SerialPort 전송 Delay(ms)
    sendDelay: CONFIG.sendDelay,
    // MQTT 브로커
    mqttBroker: 'mqtt://'+CONFIG.mqtt.server, // *************** 환경에 맞게 수정하세요! **************
    // MQTT 수신 Delay(ms)
    mqttDelay: CONFIG.mqtt.receiveDelay,

    mqttUser: CONFIG.mqtt.username,  // *************** 환경에 맞게 수정하세요! **************
    mqttPass: CONFIG.mqtt.password, // *************** 환경에 맞게 수정하세요! **************

    clientID: CONFIG.model+'-homenet',

    // 기기별 상태 및 제어 코드(HEX)
    DEVICE_STATE: [
    {deviceId: 'Light', subId: '1', stateHex: Buffer.alloc(8,'B0000100000000B1','hex'), power: 'OFF'},
    {deviceId: 'Light', subId: '1', stateHex: Buffer.alloc(8,'B0010100000000B2','hex'), power: 'ON'},

    {deviceId: 'Thermo', subId: '1', stateHex: Buffer.alloc(3,'828101','hex'), power: 'heat' , setTemp: '', curTemp: ''},
    {deviceId: 'Thermo', subId: '1', stateHex: Buffer.alloc(3,'828401','hex'), power: 'off', setTemp: '', curTemp: ''}
],

DEVICE_COMMAND: [
        {deviceId: 'Light', subId: '1', commandHex: Buffer.alloc(8,'3101000000000032','hex'), ackHex: Buffer.alloc(8,'B1000100000000B2','hex'), power: 'OFF'}, //거실1--off
        {deviceId: 'Light', subId: '1', commandHex: Buffer.alloc(8,'3101010000000033','hex'), ackHex: Buffer.alloc(8,'B1010100000000B3','hex'), power: 'ON' }, //거실1--on
    
        {deviceId: 'Thermo', subId: '1', commandHex: Buffer.alloc(8,'040104810000008a','hex'), power: 'heat' }, // 온도조절기1-on
        {deviceId: 'Thermo', subId: '1', commandHex: Buffer.alloc(8,'0401040000000009','hex'), power: 'off'} // 온도조절기1-off
],

    // 상태 Topic (/homenet/${deviceId}${subId}/${property}/state/ = ${value})
    // 명령어 Topic (/homenet/${deviceId}${subId}/${property}/command/ = ${value})
    TOPIC_PRFIX: 'homenet',
    STATE_TOPIC: 'homenet/%s%s/%s/state', //상태 전달
    DEVICE_TOPIC: 'homenet/+/+/command' //명령 수신

};


// 로그 표시
var log = (...args) => console.log('[' + new Date().toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'}) + ']', args.join(' '));

//////////////////////////////////////////////////////////////////////////////////////
// 홈컨트롤 상태
var homeStatus = {};
var lastReceive = new Date().getTime();
var mqttReady = false;
var queue = new Array();

//////////////////////////////////////////////////////////////////////////////////////
// MQTT-Broker 연결
const client  = mqtt.connect(CONST.mqttBroker, {clientId: CONST.clientID,
                                                username: CONST.mqttUser,
                                                password: CONST.mqttPass});
client.on('connect', () => {
    client.subscribe(CONST.DEVICE_TOPIC, (err) => {if (err) log('MQTT Subscribe fail! -', CONST.DEVICE_TOPIC) });
});




//////////////////////////////////////////////////////////////////////////////////////
// MQTT로 HA에 상태값 전송

var updateStatus = (obj) => {
    var arrStateName = Object.keys(obj);
    // 상태값이 아닌 항목들은 제외 [deviceId, subId, stateHex, commandHex, ackHex, sentTime]
    const arrFilter = ['deviceId', 'subId', 'stateHex', 'commandHex', 'ackHex', 'sentTime'];
    arrStateName = arrStateName.filter(stateName => !arrFilter.includes(stateName));

    // 상태값별 현재 상태 파악하여 변경되었으면 상태 반영 (MQTT publish)
    arrStateName.forEach( function(stateName) {
        // 상태값이 없거나 상태가 같으면 반영 중지
        var curStatus = homeStatus[obj.deviceId+obj.subId+stateName];
        if(obj[stateName] == null || obj[stateName] === curStatus) return;
        // 미리 상태 반영한 device의 상태 원복 방지
        if(queue.length > 0) {
            var found = queue.find(q => q.deviceId+q.subId === obj.deviceId+obj.subId && q[stateName] === curStatus);
            if(found != null) return;
        }
        // 상태 반영 (MQTT publish)
        homeStatus[obj.deviceId+obj.subId+stateName] = obj[stateName];
        var topic = util.format(CONST.STATE_TOPIC, obj.deviceId, obj.subId, stateName);
        client.publish(topic, obj[stateName], {retain: true});
        log('[MQTT] Send to HA:', topic, '->', obj[stateName]);
    });
}

//////////////////////////////////////////////////////////////////////////////////////
// HA에서 MQTT로 제어 명령 수신
client.on('message', (topic, message) => {
    if(mqttReady) {
        var topics = topic.split('/');
        var value = message.toString(); // message buffer이므로 string으로 변환
        var objFound = null;

        if(topics[0] === CONST.TOPIC_PRFIX) {
            // 온도설정 명령의 경우 모든 온도를 Hex로 정의해두기에는 많으므로 온도에 따른 시리얼 통신 메시지 생성
            if(topics[2]==='setTemp') { //040X03FF000000FF
                objFound = CONST.DEVICE_COMMAND.find(obj => obj.deviceId+obj.subId === topics[1] && obj.hasOwnProperty('setTemp'));
                objFound.commandHex[3] = parseInt(value,16);
                objFound.setTemp = String(Number(value)); // 온도값은 소수점이하는 버림
                var checkSum = objFound.commandHex[0] + objFound.commandHex[1] + objFound.commandHex[2] + objFound.commandHex[3]
                objFound.commandHex[7] = checkSum; // 마지막 Byte는 CHECKSUM
            }
            // 다른 명령은 미리 정의해놓은 값을 매칭
            else {
                objFound = CONST.DEVICE_COMMAND.find(obj => obj.deviceId+obj.subId === topics[1] && obj[topics[2]] === value);
            }
        }

        if(objFound == null) {
            log('[MQTT] Receive Unknown Msg.: ', topic, ':', value);
            return;
        }

        // 현재 상태와 같으면 Skip
        if(value === homeStatus[objFound.deviceId+objFound.subId+objFound[topics[2]]]) {
            log('[MQTT] Receive & Skip: ', topic, ':', value);
        }
        // Serial메시지 제어명령 전송 & MQTT로 상태정보 전송
        else {
            log('[MQTT] Receive from HA:', topic, ':', value);
            // 최초 실행시 딜레이 없도록 sentTime을 현재시간 보다 sendDelay만큼 이전으로 설정
            objFound.sentTime = (new Date().getTime())-CONST.sendDelay;
            queue.push(objFound);   // 실행 큐에 저장
            updateStatus(objFound); // 처리시간의 Delay때문에 미리 상태 반영
        }
    }
});


setTimeout(() => {mqttReady=true; log('MQTT Ready...')}, CONST.mqttDelay);

