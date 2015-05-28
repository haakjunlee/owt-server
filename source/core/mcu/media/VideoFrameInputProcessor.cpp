/*
 * Copyright 2015 Intel Corporation All Rights Reserved.
 *
 * The source code contained or described herein and all documents related to the
 * source code ("Material") are owned by Intel Corporation or its suppliers or
 * licensors. Title to the Material remains with Intel Corporation or its suppliers
 * and licensors. The Material contains trade secrets and proprietary and
 * confidential information of Intel or its suppliers and licensors. The Material
 * is protected by worldwide copyright and trade secret laws and treaty provisions.
 * No part of the Material may be used, copied, reproduced, modified, published,
 * uploaded, posted, transmitted, distributed, or disclosed in any way without
 * Intel's prior express written permission.
 *
 * No license under any patent, copyright, trade secret or other intellectual
 * property right is granted to or conferred upon you by disclosure or delivery of
 * the Materials, either expressly, by implication, inducement, estoppel or
 * otherwise. Any license under such intellectual property rights must be express
 * and approved by Intel in writing.
 */

#include "VideoFrameInputProcessor.h"

using namespace webrtc;
using namespace erizo;

namespace mcu {

DEFINE_LOGGER(VideoFrameInputProcessor, "mcu.media.VideoFrameInputProcessor");

VideoFrameInputProcessor::VideoFrameInputProcessor(int index, bool externalDecoding)
    : m_index(index)
    , m_externalDecoding(externalDecoding)
{
}

VideoFrameInputProcessor::~VideoFrameInputProcessor()
{
}

bool VideoFrameInputProcessor::init(boost::shared_ptr<VideoFrameMixer> frameReceiver)
{
    m_frameReceiver = frameReceiver;
    return true;
}

int VideoFrameInputProcessor::deliverVideoData(char* buf, int len)
{
    //ELOG_DEBUG("Receive video frame packet with size %d ", len);
    return 0;
}

int VideoFrameInputProcessor::deliverAudioData(char* buf, int len)
{
    assert(false);
    return 0;
}

}