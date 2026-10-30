#include <WiFi.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

static const uint32_t SERIAL_BAUD = 115200;
static const uint8_t MAX_NETWORKS = 32;
static const uint8_t MAX_BLE_DEVICES = 32;
static const uint8_t BLE_SCAN_SECONDS = 5;
static const char *FIRMWARE_VERSION = "0.3.0-arduino";

String commandBuffer;
BLEScan *bleScanner = nullptr;
bool bleReady = false;

String jsonEscape(String value) {
  value.replace("\\", "\\\\");
  value.replace("\"", "\\\"");
  value.replace("\n", "\\n");
  value.replace("\r", "\\r");
  value.replace("\t", "\\t");
  return value;
}

String bytesToHex(const String &value, size_t maxBytes = 12) {
  static const char HEX_DIGITS[] = "0123456789ABCDEF";
  String output;
  const size_t count = min(value.length(), maxBytes);
  output.reserve(count * 2);
  for (size_t index = 0; index < count; index++) {
    const uint8_t byteValue = (uint8_t)value[index];
    output += HEX_DIGITS[byteValue >> 4];
    output += HEX_DIGITS[byteValue & 0x0F];
  }
  return output;
}

const char *bleAddressTypeLabel(uint8_t type) {
  switch (type) {
    case 0: return "public";
    case 1: return "random";
    case 2: return "public_identity";
    case 3: return "random_identity";
    default: return "unknown";
  }
}

bool initializeBle() {
  if (bleReady && bleScanner != nullptr) return true;
  if (!BLEDevice::init("")) return false;
  bleScanner = BLEDevice::getScan();
  if (bleScanner == nullptr) return false;
  bleScanner->setActiveScan(true);
  bleScanner->setInterval(100);
  bleScanner->setWindow(80);
  bleReady = true;
  return true;
}

void sendIdentity() {
  uint64_t chipId = ESP.getEfuseMac();
  char id[18];
  snprintf(id, sizeof(id), "%04X%08X", (uint16_t)(chipId >> 32), (uint32_t)chipId);
  Serial.printf(
    "{\"type\":\"identity\",\"protocol\":2,\"board\":\"nodemcu-esp32s\","
    "\"chip\":\"ESP32\",\"mac\":\"%s\",\"wifi\":true,\"ble\":true}\n",
    id
  );
}

void sendStatus() {
  Serial.printf(
    "{\"type\":\"status\",\"protocol\":2,\"heap_free\":%u,\"uptime_ms\":%lu,"
    "\"ble_ready\":%s,\"ble_scanning\":%s}\n",
    ESP.getFreeHeap(), millis(), bleReady ? "true" : "false",
    (bleScanner != nullptr && bleScanner->isScanning()) ? "true" : "false"
  );
}

void sendBleStatus() {
  const bool ready = initializeBle();
  Serial.printf(
    "{\"type\":\"ble_status\",\"available\":true,\"ready\":%s,"
    "\"scanning\":%s,\"mode\":\"BLE active scan\",\"duration_s\":%u}\n",
    ready ? "true" : "false",
    (bleScanner != nullptr && bleScanner->isScanning()) ? "true" : "false",
    BLE_SCAN_SECONDS
  );
}

void scanWifi() {
  Serial.println("{\"type\":\"wifi_scan_started\"}");
  const int found = WiFi.scanNetworks(false, true, false, 160);
  if (found < 0) {
    Serial.println("{\"type\":\"error\",\"module\":\"wifi\",\"code\":\"wifi_scan_failed\"}");
    return;
  }
  const int count = min(found, (int)MAX_NETWORKS);
  for (int index = 0; index < count; index++) {
    const String ssid = jsonEscape(WiFi.SSID(index));
    Serial.printf(
      "{\"type\":\"wifi_ap\",\"ssid\":\"%s\",\"rssi\":%d,\"channel\":%d,"
      "\"auth\":%d,\"bssid\":\"%s\"}\n",
      ssid.c_str(), WiFi.RSSI(index), WiFi.channel(index),
      (int)WiFi.encryptionType(index), WiFi.BSSIDstr(index).c_str()
    );
  }
  Serial.printf("{\"type\":\"wifi_scan_finished\",\"count\":%d,\"truncated\":%s}\n",
    count, found > MAX_NETWORKS ? "true" : "false");
  WiFi.scanDelete();
}

String advertisedServices(BLEAdvertisedDevice &device) {
  String services;
  const int count = min(device.getServiceUUIDCount(), 3);
  for (int index = 0; index < count; index++) {
    if (index > 0) services += ",";
    services += device.getServiceUUID(index).toString();
  }
  return jsonEscape(services);
}

void sendBleDevice(BLEAdvertisedDevice &device) {
  const String name = device.haveName() ? jsonEscape(device.getName()) : "";
  const String address = device.getAddress().toString();
  const String manufacturer = device.haveManufacturerData() ? device.getManufacturerData() : "";
  const String manufacturerHex = bytesToHex(manufacturer);
  int manufacturerId = -1;
  if (manufacturer.length() >= 2) {
    manufacturerId = (uint8_t)manufacturer[0] | ((uint8_t)manufacturer[1] << 8);
  }
  const String services = advertisedServices(device);

  Serial.printf(
    "{\"type\":\"ble_device\",\"name\":\"%s\",\"address\":\"%s\","
    "\"address_type\":\"%s\",\"rssi\":%d,\"connectable\":%s,"
    "\"scannable\":%s,\"manufacturer_id\":%d,\"manufacturer_data\":\"%s\","
    "\"services\":\"%s\",\"tx_power\":%d}\n",
    name.c_str(), address.c_str(), bleAddressTypeLabel(device.getAddressType()),
    device.getRSSI(), device.isConnectable() ? "true" : "false",
    device.isScannable() ? "true" : "false", manufacturerId,
    manufacturerHex.c_str(), services.c_str(), device.haveTXPower() ? device.getTXPower() : 127
  );
}

void scanBle() {
  Serial.printf("{\"type\":\"ble_scan_started\",\"duration_s\":%u}\n", BLE_SCAN_SECONDS);
  if (!initializeBle()) {
    Serial.println("{\"type\":\"error\",\"module\":\"ble\",\"code\":\"ble_init_failed\"}");
    Serial.println("{\"type\":\"ble_scan_finished\",\"count\":0,\"failed\":true}");
    return;
  }

  bleScanner->clearResults();
  BLEScanResults *results = bleScanner->start(BLE_SCAN_SECONDS, false);
  if (results == nullptr) {
    Serial.println("{\"type\":\"error\",\"module\":\"ble\",\"code\":\"ble_scan_failed\"}");
    Serial.println("{\"type\":\"ble_scan_finished\",\"count\":0,\"failed\":true}");
    return;
  }

  const int found = results->getCount();
  const int count = min(found, (int)MAX_BLE_DEVICES);
  for (int index = 0; index < count; index++) {
    BLEAdvertisedDevice device = results->getDevice(index);
    sendBleDevice(device);
    delay(1);
  }
  Serial.printf(
    "{\"type\":\"ble_scan_finished\",\"count\":%d,\"observed\":%d,\"truncated\":%s}\n",
    count, found, found > MAX_BLE_DEVICES ? "true" : "false"
  );
  bleScanner->clearResults();
}

void processCommand(String command) {
  command.trim();
  if (command.length() == 0) return;
  if (command == "PING") {
    Serial.println("{\"type\":\"pong\",\"protocol\":2}");
  } else if (command == "INFO") {
    sendIdentity();
  } else if (command == "STATUS") {
    sendStatus();
  } else if (command == "BLE_STATUS") {
    sendBleStatus();
  } else if (command == "SCAN_WIFI") {
    scanWifi();
  } else if (command == "SCAN_BLE") {
    scanBle();
  } else if (command == "REBOOT") {
    Serial.println("{\"type\":\"restarting\"}");
    delay(100);
    ESP.restart();
  } else {
    Serial.println("{\"type\":\"error\",\"code\":\"unknown_command\"}");
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(250);
  bleReady = initializeBle();
  Serial.printf(
    "{\"type\":\"ready\",\"protocol\":2,\"firmware\":\"%s\",\"ble_ready\":%s}\n",
    FIRMWARE_VERSION, bleReady ? "true" : "false"
  );
}

void loop() {
  while (Serial.available() > 0) {
    const char character = (char)Serial.read();
    if (character == '\n') {
      processCommand(commandBuffer);
      commandBuffer = "";
    } else if (character != '\r' && commandBuffer.length() < 96) {
      commandBuffer += character;
    }
  }
  delay(2);
}
